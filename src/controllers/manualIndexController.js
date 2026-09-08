'use strict';

const { activeConnection, activeCluster } = require('../config/clusterConnections');
const ManualIndex = require('../models/ManualIndex');
const AuditLog = require('../models/AuditLog');
const auditService = require('../services/auditService');
const indexService = require('../services/indexService');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { sendSuccess, buildPagination } = require('../utils/apiResponse');
const { containsInsensitive, equalsInsensitive } = require('../utils/query');
const { validateCreate, parseFilterExpression } = require('../validators/manualIndexValidator');

const EDITABLE_FIELDS = [
  'indexName',
  'description',
  'databaseName',
  'collectionName',
  'keys',
  'indexType',
  'options',
  'status',
];

// Directions that are index-type strings rather than an ordering number.
const SPECIAL_DIRECTIONS = new Set(['text', 'hashed', '2dsphere', '2d']);

/** Normalise an incoming payload into the shape stored on the model. */
function normalize(body) {
  const keys = Array.isArray(body.keys)
    ? body.keys.map((k) => {
        const direction = String(k.direction);
        return {
          field: String(k.field).trim(),
          direction: SPECIAL_DIRECTIONS.has(direction) ? direction : Number(direction),
        };
      })
    : undefined;

  const rawOptions = body.options || {};
  const options = {
    unique: body.indexType === 'UNIQUE' ? true : !!rawOptions.unique,
    sparse: !!rawOptions.sparse,
    background: rawOptions.background === undefined ? true : !!rawOptions.background,
    expireAfterSeconds:
      body.indexType === 'TTL' && rawOptions.expireAfterSeconds !== undefined && rawOptions.expireAfterSeconds !== ''
        ? Number(rawOptions.expireAfterSeconds)
        : null,
    // Kept for every index type, not just PARTIAL.
    partialFilterExpression: parseFilterExpression(rawOptions.partialFilterExpression).value,
  };

  const out = { options };
  if (body.indexName !== undefined) out.indexName = String(body.indexName).trim();
  if (body.description !== undefined) out.description = String(body.description).trim();
  if (body.databaseName !== undefined) {
    out.databaseName = String(body.databaseName || '').trim();
    // Checked while it is still just a definition: a DRAFT naming a database
    // outside the signed-in cluster must be refused at save time, not later
    // when someone tries to apply it.
    if (out.databaseName) indexService.resolveDatabaseName(out.databaseName);
  }
  if (body.collectionName !== undefined) out.collectionName = String(body.collectionName).trim();
  if (keys !== undefined) out.keys = keys;
  if (body.indexType !== undefined) out.indexType = body.indexType;
  if (body.status !== undefined) out.status = body.status;
  return out;
}

/** The definition passed to the index service — a plain object is enough. */
function specOf(source) {
  return {
    indexName: source.indexName,
    databaseName: source.databaseName,
    collectionName: source.collectionName,
    keys: source.keys,
    indexType: source.indexType,
    options: source.options,
    appliedIndexName: source.appliedIndexName,
  };
}

/** Normalise pagination/sort query params. */
function parseListQuery(query) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 10, 1), 100);
  const allowedSort = ['indexName', 'createdAt', 'updatedAt', 'status', 'indexType', 'createdBy', 'collectionName'];
  const sortBy = allowedSort.includes(query.sortBy) ? query.sortBy : 'createdAt';
  const sortOrder = query.sortOrder === 'asc' ? 1 : -1;
  return { page, limit, sortBy, sortOrder };
}

/**
 * POST /api/manual-indexes
 *
 * Creates the definition AND, when the status is ACTIVE, the real MongoDB
 * index. The index is created first: if MongoDB rejects it, nothing is saved,
 * so the register never claims an index that does not exist.
 */
const createManualIndex = asyncHandler(async (req, res) => {
  const payload = normalize(req.body);

  const existing = await ManualIndex.findOne({ indexName: equalsInsensitive(payload.indexName) });
  if (existing) {
    throw ApiError.conflict(`A Manual Index named "${payload.indexName}" already exists`);
  }

  let applied = false;
  let appliedIndexName = '';
  let appliedAt = null;

  const willApply = (payload.status || 'ACTIVE') === 'ACTIVE';
  if (willApply) {
    appliedIndexName = await indexService.applyIndex(specOf(payload));
    applied = true;
    appliedAt = new Date();
  }

  let index;
  try {
    index = await ManualIndex.create({
      ...payload,
      status: payload.status || 'ACTIVE',
      applied,
      appliedIndexName,
      appliedAt,
      lastSyncError: '',
      createdBy: req.user.userName,
      createdByUserId: req.user.userId,
      updatedBy: req.user.userName,
    });
  } catch (err) {
    // Saving failed after the index was created — undo it so the database and
    // the register cannot drift apart.
    if (applied) {
      await indexService
        .dropIndex({ databaseName: payload.databaseName, collectionName: payload.collectionName, appliedIndexName })
        .catch(() => {});
    }
    throw err;
  }

  await auditService.logCreate({
    index,
    user: req.user,
    req,
    // Only when an index was really created: a DRAFT ran no command, and
    // recording one would claim the database was touched when it was not.
    mongoCommand: applied ? indexService.createIndexCommand(index) : '',
    details: applied
      ? `Manual Index "${index.indexName}" was created and applied to MongoDB — ${indexService.describeSpec(index)}`
      : `Manual Index "${index.indexName}" was created as ${index.status} (definition only, not applied to MongoDB)`,
  });

  return sendSuccess(res, {
    statusCode: 201,
    message: applied
      ? `Manual Index created and the real index now exists on "${index.databaseName || indexService.defaultDatabaseName()}.${index.collectionName}"`
      : 'Manual Index definition created (not applied — status is not ACTIVE)',
    data: index,
  });
});

/**
 * GET /api/manual-indexes
 * Listing is not an audited action — only opening a specific index's details is.
 */
const getManualIndexes = asyncHandler(async (req, res) => {
  const { page, limit, sortBy, sortOrder } = parseListQuery(req.query);
  const { search, status, indexType, collectionName, databaseName, applied } = req.query;

  const filter = {};
  if (search && String(search).trim()) {
    const rx = containsInsensitive(String(search).trim());
    filter.$or = [{ indexName: rx }, { description: rx }, { collectionName: rx }, { createdBy: rx }];
  }
  if (status) filter.status = status;
  if (indexType) filter.indexType = indexType;
  if (collectionName) filter.collectionName = collectionName;
  if (databaseName) filter.databaseName = databaseName;
  if (applied === 'true' || applied === 'false') filter.applied = applied === 'true';

  const [items, total] = await Promise.all([
    ManualIndex.find(filter)
      .sort({ [sortBy]: sortOrder })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    ManualIndex.countDocuments(filter),
  ]);

  return sendSuccess(res, {
    message: 'Manual Indexes fetched successfully',
    data: items,
    meta: buildPagination({ page, limit, total }),
  });
});

/**
 * GET /api/manual-indexes/:id
 * Returns the details and automatically writes a VIEW audit log, as required.
 */
const getManualIndexById = asyncHandler(async (req, res) => {
  const index = await ManualIndex.findById(req.params.id);
  if (!index) throw ApiError.notFound('Manual Index not found');

  await auditService.logView({ index, user: req.user, req });

  const [recentActivity, dbStatus] = await Promise.all([
    AuditLog.find({ indexId: index._id }).sort({ timestamp: -1 }).limit(5).lean(),
    indexService.getSyncStatus(index).catch((err) => ({
      inSync: false,
      message: `Could not check MongoDB: ${err.message}`,
    })),
  ]);

  return sendSuccess(res, {
    message: 'Manual Index fetched successfully',
    data: { ...index.toObject(), recentActivity, dbStatus },
  });
});

/**
 * PUT /api/manual-indexes/:id
 *
 * MongoDB indexes cannot be altered in place, so a change is applied as
 * drop-then-create. If the new index is rejected, the previous one is restored
 * and nothing is saved.
 */
const updateManualIndex = asyncHandler(async (req, res) => {
  const index = await ManualIndex.findById(req.params.id);
  if (!index) throw ApiError.notFound('Manual Index not found');

  const previousValues = index.toAuditSnapshot();
  const previousSpec = specOf(index);
  const wasApplied = Boolean(index.applied && index.appliedIndexName);

  // Validate the MERGED result, so a partial update cannot produce an invalid
  // definition (for example a TTL index left without expireAfterSeconds).
  const merged = {
    indexName: index.indexName,
    description: index.description,
    databaseName: index.databaseName,
    collectionName: index.collectionName,
    keys: index.keys.map((k) => ({ field: k.field, direction: k.direction })),
    indexType: index.indexType,
    status: index.status,
    options: {
      unique: index.options.unique,
      sparse: index.options.sparse,
      expireAfterSeconds: index.options.expireAfterSeconds,
      partialFilterExpression: index.options.partialFilterExpression,
    },
    ...req.body,
  };
  if (req.body.options) merged.options = { ...merged.options, ...req.body.options };

  const errors = validateCreate(merged);
  if (errors.length) throw ApiError.badRequest('Validation failed', errors);

  const payload = normalize(merged);

  if (payload.indexName !== index.indexName) {
    const clash = await ManualIndex.findOne({
      _id: { $ne: index._id },
      indexName: equalsInsensitive(payload.indexName),
    });
    if (clash) throw ApiError.conflict(`A Manual Index named "${payload.indexName}" already exists`);
  }

  const willBeActive = payload.status === 'ACTIVE';

  // --- Apply the change to MongoDB before touching the register ------------
  if (wasApplied) {
    await indexService.dropIndex(previousSpec);
  }

  let appliedIndexName = '';
  if (willBeActive) {
    try {
      appliedIndexName = await indexService.applyIndex(specOf(payload));
    } catch (err) {
      // Restore what was there before, so a rejected edit changes nothing.
      if (wasApplied) {
        await indexService.applyIndex(previousSpec).catch(() => {});
      }
      throw err;
    }
  }

  for (const field of EDITABLE_FIELDS) {
    if (payload[field] !== undefined) index[field] = payload[field];
  }
  index.applied = willBeActive;
  index.appliedIndexName = willBeActive ? appliedIndexName : '';
  index.appliedAt = willBeActive ? new Date() : null;
  index.lastSyncError = '';
  index.updatedBy = req.user.userName;

  try {
    await index.save();
  } catch (err) {
    // Put MongoDB back the way it was if the record could not be saved.
    if (willBeActive) await indexService.dropIndex(specOf({ ...payload, appliedIndexName })).catch(() => {});
    if (wasApplied) await indexService.applyIndex(previousSpec).catch(() => {});
    throw err;
  }

  const newValues = index.toAuditSnapshot();
  let dbNote = '';
  if (wasApplied && willBeActive) dbNote = ' — the real MongoDB index was dropped and recreated';
  else if (willBeActive) dbNote = ' — the real MongoDB index was created';
  else if (wasApplied) dbNote = ' — the real MongoDB index was dropped';

  await auditService.logUpdate({
    index,
    user: req.user,
    previousValues,
    newValues,
    req,
    // An edit is a drop-then-create, so both lines are recorded, in the order
    // they ran — one of them alone would misrepresent what happened.
    mongoCommand: [
      wasApplied ? indexService.dropIndexCommand({ ...previousSpec, indexName: previousSpec.appliedIndexName }) : '',
      willBeActive ? indexService.createIndexCommand(index) : '',
    ]
      .filter(Boolean)
      .join('\n'),
    detailsSuffix: dbNote,
  });

  return sendSuccess(res, {
    message: `Manual Index updated${dbNote}`,
    data: index,
  });
});

/**
 * DELETE /api/manual-indexes/:id
 * Drops the real index, then removes the definition. The audit entry survives.
 */
const deleteManualIndex = asyncHandler(async (req, res) => {
  const index = await ManualIndex.findById(req.params.id);
  if (!index) throw ApiError.notFound('Manual Index not found');

  let dropResult = { dropped: false };
  let deleteCommand = '';
  if (index.applied && index.appliedIndexName) {
    deleteCommand = indexService.dropIndexCommand({
      databaseName: index.databaseName,
      collectionName: index.collectionName,
      indexName: index.appliedIndexName,
    });
    dropResult = await indexService.dropIndex(specOf(index));
  }

  await auditService.logDelete({
    index,
    user: req.user,
    req,
    mongoCommand: deleteCommand,
    details: dropResult.dropped
      ? `Manual Index "${index.indexName}" was deleted and the real index was dropped from "${index.databaseName || indexService.defaultDatabaseName()}.${index.collectionName}"`
      : `Manual Index "${index.indexName}" was deleted (no real index to drop)`,
  });

  await ManualIndex.deleteOne({ _id: index._id });

  return sendSuccess(res, {
    message: dropResult.dropped
      ? 'Manual Index deleted and the real MongoDB index was dropped'
      : 'Manual Index deleted',
    data: { _id: index._id, indexName: index.indexName, indexDropped: dropResult.dropped },
  });
});

/**
 * GET /api/manual-indexes/:id/db-status
 * Live comparison between the definition and MongoDB, so drift is visible.
 */
const getDbStatus = asyncHandler(async (req, res) => {
  const index = await ManualIndex.findById(req.params.id);
  if (!index) throw ApiError.notFound('Manual Index not found');

  return sendSuccess(res, {
    message: 'Database status fetched successfully',
    data: await indexService.getSyncStatus(index),
  });
});

/**
 * POST /api/manual-indexes/:id/sync
 * Force MongoDB to match the definition again — useful when an index was
 * dropped outside the application, or after switching databases.
 */
const syncManualIndex = asyncHandler(async (req, res) => {
  const index = await ManualIndex.findById(req.params.id);
  if (!index) throw ApiError.notFound('Manual Index not found');

  const previousValues = index.toAuditSnapshot();

  if (index.appliedIndexName) await indexService.dropIndex(specOf(index)).catch(() => {});

  let message;
  if (index.status === 'ACTIVE') {
    index.appliedIndexName = await indexService.applyIndex(specOf(index));
    index.applied = true;
    index.appliedAt = new Date();
    message = `The real index now exists on "${index.databaseName || indexService.defaultDatabaseName()}.${index.collectionName}"`;
  } else {
    index.applied = false;
    index.appliedIndexName = '';
    index.appliedAt = null;
    message = 'This definition is not ACTIVE, so no index is applied';
  }

  index.lastSyncError = '';
  index.updatedBy = req.user.userName;
  await index.save();

  await auditService.logUpdate({
    index,
    user: req.user,
    previousValues,
    newValues: index.toAuditSnapshot(),
    req,
    mongoCommand: index.applied ? indexService.createIndexCommand(index) : '',
    detailsSuffix: ` — re-synchronised with MongoDB (${message})`,
  });

  return sendSuccess(res, { message, data: index });
});

/**
 * POST /api/manual-indexes/:id/drop
 * Remove the real index from MongoDB but keep the definition.
 *
 * Deliberately narrower than DELETE: that path destroys the record too, so it
 * is the wrong tool for "stop paying for this index while we watch what
 * happens". The definition survives here, which is what makes the move
 * reversible — Sync rebuilds the index from it, unchanged.
 *
 * The status drops to INACTIVE with it. Leaving it ACTIVE would leave the
 * record asserting an index that is deliberately gone, so every later
 * db-status read would report drift that nobody intends to fix.
 */
const dropManualIndex = asyncHandler(async (req, res) => {
  const index = await ManualIndex.findById(req.params.id);
  if (!index) throw ApiError.notFound('Manual Index not found');

  if (!index.applied && !index.appliedIndexName) {
    throw ApiError.badRequest(
      'This definition has no index applied in MongoDB, so there is nothing to drop'
    );
  }

  const previousValues = index.toAuditSnapshot();
  const databaseLabel = `${index.databaseName || indexService.defaultDatabaseName()}.${index.collectionName}`;
  const droppedName = index.appliedIndexName;
  // Built before the drop, while the applied name is still on the record — the
  // fields it reads are cleared a few lines below.
  const dropCommand = indexService.dropIndexCommand({
    databaseName: index.databaseName,
    collectionName: index.collectionName,
    indexName: droppedName,
  });

  // Throws on a real MongoDB refusal; an index that is already gone reports
  // dropped: false and is treated as success, so the record still ends up
  // agreeing with the database.
  const dropResult = await indexService.dropIndex(specOf(index));

  index.applied = false;
  index.appliedIndexName = '';
  index.appliedAt = null;
  index.status = 'INACTIVE';
  index.lastSyncError = '';
  index.updatedBy = req.user.userName;
  await index.save();

  await auditService.record({
    action: 'DROP',
    index,
    user: req.user,
    previousValues,
    newValues: index.toAuditSnapshot(),
    req,
    mongoCommand: dropCommand,
    details: dropResult.dropped
      ? `Index "${droppedName}" was dropped from ${databaseLabel}; Manual Index "${index.indexName}" was kept and set to INACTIVE`
      : `Manual Index "${index.indexName}" was set to INACTIVE; its index was already absent from ${databaseLabel} (${dropResult.reason})`,
  });

  return sendSuccess(res, {
    message: dropResult.dropped
      ? `The index was dropped from ${databaseLabel}. The definition was kept — use Sync to rebuild it.`
      : `No index was found in ${databaseLabel}; the definition was kept and marked INACTIVE.`,
    data: index,
  });
});

/**
 * GET /api/manual-indexes/meta/collections
 * Collections in the connected database with their real index names, so the
 * UI can offer a target rather than asking the user to type one blind.
 */
const getCollections = asyncHandler(async (req, res) => {
  const databaseName = (req.query.database || '').trim() || undefined;

  const names = await indexService.listCollections(databaseName);

  const data = await Promise.all(
    names.map(async (name) => {
      const indexes = await indexService.listCollectionIndexes(name, databaseName).catch(() => []);
      return { name, indexes: indexes.map((i) => ({ name: i.name, key: i.key })) };
    })
  );

  return sendSuccess(res, {
    message: 'Collections fetched successfully',
    data: data.sort((a, b) => a.name.localeCompare(b.name)),
    meta: { database: indexService.resolveDatabaseName(databaseName) },
  });
});

/**
 * GET /api/manual-indexes/meta/fields
 * Field names of one collection, so the index-key rows can offer a dropdown
 * instead of asking the user to remember and retype a field path.
 */
const getFields = asyncHandler(async (req, res) => {
  const databaseName = (req.query.database || '').trim() || undefined;
  const collectionName = (req.query.collection || '').trim();

  if (!collectionName) {
    throw ApiError.badRequest('A collection is required to list its fields', [
      { field: 'collection', message: 'A collection is required to list its fields' },
    ]);
  }

  let fields = [];
  let message = 'Fields fetched successfully';
  try {
    fields = await indexService.listFields(collectionName, databaseName);
  } catch (err) {
    // Sampling is a convenience: an unreadable collection must not stop the
    // form, which still accepts a typed field name.
    message = `Could not read field names (${err.message}). You can still type a field name.`;
  }

  return sendSuccess(res, {
    message,
    data: { fields },
    meta: {
      database: indexService.resolveDatabaseName(databaseName),
      collection: collectionName,
      sampled: true,
    },
  });
});

/**
 * GET /api/manual-indexes/meta/databases
 * Databases on the connected server, so an index can be created on the one
 * holding the application's real data rather than on DBA Utility's own.
 */
const getDatabases = asyncHandler(async (req, res) => {
  let databases = [];
  let message = 'Databases fetched successfully';
  try {
    databases = await indexService.listDatabases();
  } catch (err) {
    message =
      `Could not list databases (${err.message}). ` +
      'The database user may lack the listDatabases privilege — you can still type a database name by hand.';
  }

  return sendSuccess(res, {
    message,
    data: {
      databases,
      current: indexService.defaultDatabaseName(),
      connected: activeConnection().name || null,
      cluster: activeCluster() ? { key: activeCluster().key, label: activeCluster().label } : null,
    },
  });
});

/** GET /api/manual-indexes/stats/summary — dashboard aggregates. */
const getSummary = asyncHandler(async (req, res) => {
  const [totalIndexes, byStatus, byType, totalLogs, recentLogs, actionCounts, appliedCount] =
    await Promise.all([
      ManualIndex.countDocuments(),
      ManualIndex.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      ManualIndex.aggregate([{ $group: { _id: '$indexType', count: { $sum: 1 } } }]),
      AuditLog.countDocuments(),
      // VIEW entries dominate the feed and drown out the changes that matter,
      // so the dashboard shows the actions that altered something. The full
      // count is still reported separately in actionCounts.
      AuditLog.find({ action: { $ne: 'VIEW' } }).sort({ timestamp: -1 }).limit(6).lean(),
      AuditLog.aggregate([{ $group: { _id: '$action', count: { $sum: 1 } } }]),
      ManualIndex.countDocuments({ applied: true }),
    ]);

  const toMap = (rows) =>
    rows.reduce((acc, row) => {
      acc[row._id] = row.count;
      return acc;
    }, {});

  return sendSuccess(res, {
    message: 'Summary fetched successfully',
    data: {
      totalIndexes,
      totalAuditLogs: totalLogs,
      appliedIndexes: appliedCount,
      byStatus: toMap(byStatus),
      byType: toMap(byType),
      actionCounts: toMap(actionCounts),
      recentLogs,
    },
  });
});

module.exports = {
  createManualIndex,
  getManualIndexes,
  getManualIndexById,
  updateManualIndex,
  deleteManualIndex,
  getDbStatus,
  syncManualIndex,
  dropManualIndex,
  getCollections,
  getFields,
  getDatabases,
  getSummary,
};
