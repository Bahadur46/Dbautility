'use strict';

const mongoose = require('mongoose');
const OptimizationActivity = require('../models/OptimizationActivity');
const ApiError = require('../utils/ApiError');
const indexLinkService = require('./indexLinkService');
const { activeCluster } = require('../config/clusterConnections');

/**
 * Writes to the optimisation record that feeds the dashboard.
 *
 * Same rule as the audit service: a dashboard write never breaks the operation
 * it describes. If this collection is unreachable the index was still created,
 * and failing the request over a statistics row would be the wrong trade. The
 * failure goes to stderr so operators can see it.
 */

/** Coerce one measurement payload into the schema's shape. */
function measurement(input) {
  if (!input || typeof input !== 'object') return {};
  const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  return {
    executionTimeMs: num(input.executionTimeMs),
    documentsExamined: num(input.documentsExamined),
    documentsReturned: num(input.documentsReturned),
    keysExamined: num(input.keysExamined),
    planStage: String(input.planStage || '').trim(),
    indexUsed: String(input.indexUsed || '').trim(),
  };
}

/**
 * Persist one optimisation activity.
 *
 * @returns the saved document, or null when the write failed.
 */
async function record({
  activityType,
  databaseName = '',
  collectionName = '',
  subject,
  subjectDetail = null,
  before = null,
  after = null,
  status = 'APPLIED',
  user,
  auditLogId = null,
  manualIndexId = null,
  longQueryId = null,
  longQueryLink = null,
  notes = '',
  clientName = '',
  timestamp = null,
}) {
  try {
    // Read before the write: the model resolves onto the central connection,
    // but the cluster being worked on is the ambient one for this request.
    const cluster = activeCluster();

    return await OptimizationActivity.create({
      activityType,
      cluster: cluster ? cluster.key : '',
      clusterLabel: cluster ? cluster.label : '',
      databaseName: String(databaseName || '').trim(),
      collectionName: String(collectionName || '').trim(),
      subject: String(subject || '').slice(0, 500),
      subjectDetail,
      before: measurement(before),
      after: measurement(after),
      status,
      userId: user.userId,
      userName: user.userName,
      auditLogId: auditLogId || null,
      manualIndexId: manualIndexId || null,
      longQueryId: longQueryId || null,
      longQueryLink: longQueryLink || null,
      notes: String(notes || '').slice(0, 1000),
      clientName: String(clientName || '').trim().slice(0, 200),
      timestamp: timestamp ? new Date(timestamp) : new Date(),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[dashboard] Failed to record optimisation activity:', err.message, {
      activityType,
    });
    return null;
  }
}

/**
 * An index was created and really applied to MongoDB.
 *
 * Deliberately not called for DRAFT/INACTIVE definitions: nothing was applied,
 * so nothing was optimised, and counting them would inflate the card above what
 * the database actually gained.
 */
async function recordIndexCreated({
  index,
  user,
  auditLog = null,
  notes = '',
  databaseName = '',
  longQueryId = null,
}) {
  const activity = await record({
    activityType: 'INDEX_CREATED',
    databaseName: databaseName || index.databaseName || '',
    collectionName: index.collectionName,
    subject: index.appliedIndexName || index.indexName,
    subjectDetail: { indexType: index.indexType, keys: index.keys, options: index.options },
    manualIndexId: index._id || null,
    longQueryId,
    // A caller naming the task is a statement, not an inference.
    longQueryLink: longQueryId ? { method: 'manual', score: null } : null,
    auditLogId: auditLog ? auditLog._id : null,
    user,
    notes,
  });
  // No task named by the caller — which is what the index screen sends today —
  // so find the long query this index was built for.
  if (activity && !activity.longQueryId) await autoLinkIndex(activity);
  return activity;
}

/**
 * Link one unlinked INDEX_CREATED row to the long query it fixed, if any.
 * Matching is by fields, not just time — see indexLinkService.
 * Never throws: like every dashboard write, it must not fail the index create.
 * @returns the long query id linked, or null.
 */
async function autoLinkIndex(indexActivity) {
  try {
    if (indexActivity.activityType !== 'INDEX_CREATED' || indexActivity.longQueryId) return null;
    const best = await indexLinkService.bestLongQueryFor(indexActivity);
    if (!best) return null;
    await indexLinkService.saveLink(indexActivity._id, best);
    indexActivity.longQueryId = best.query._id;
    return best.query._id;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[dashboard] Failed to link index to a long query:', err.message);
    return null;
  }
}

/**
 * Claim the unlinked indexes on a long query's collection that belong to it —
 * for the order where the index was built first and the query logged after.
 * An index goes to this query only when this is its best match, so two queries
 * on the same collection each keep their own fixes.
 * @returns how many indexes the query now has.
 */
async function autoLinkLongQuery(longQuery) {
  try {
    if (longQuery.activityType !== 'LONG_QUERY' || !longQuery.collectionName) return 0;
    const at = new Date(longQuery.timestamp);
    const window = indexLinkService.FIELD_WINDOW_MS;
    // Unlinked indexes, and ones the server linked to another query. An index
    // built minutes before its own query is recorded gets linked to an older
    // query that only partly fits; when the real one arrives it must be able
    // to take it back. Manual links are never moved.
    const candidates = await OptimizationActivity.find({
      activityType: 'INDEX_CREATED',
      cluster: longQuery.cluster || '',
      databaseName: longQuery.databaseName || '',
      collectionName: longQuery.collectionName,
      timestamp: { $gte: new Date(at - window), $lte: new Date(at.getTime() + window) },
      $or: [
        { longQueryId: null },
        {
          longQueryId: { $ne: longQuery._id },
          'longQueryLink.method': { $in: indexLinkService.AUTO_METHODS },
        },
      ],
    }).lean();
    const dropped = await indexLinkService.droppedIndexIds(candidates);

    for (const index of candidates) {
      if (dropped.has(String(index._id))) continue;
      const best = await indexLinkService.bestLongQueryFor(index);
      if (!best || String(best.query._id) !== String(longQuery._id)) continue;
      if (!index.longQueryId) {
        await indexLinkService.saveLink(index._id, best);
      } else if (best.match.score > ((index.longQueryLink && index.longQueryLink.score) || 0)) {
        // Strictly better only: on a tie the index stays with its current query.
        await indexLinkService.moveLink(index, best);
      }
    }
    return OptimizationActivity.countDocuments({ activityType: 'INDEX_CREATED', longQueryId: longQuery._id });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[dashboard] Failed to link indexes to a long query:', err.message);
    return 0;
  }
}

/**
 * Validate an optional long query id from a request into an ObjectId, or null.
 *
 * Refused unless it names a real LONG_QUERY row: a link to nothing, or to an API
 * optimisation, would hide an index from the task count without any task
 * accounting for it.
 */
async function resolveLongQueryId(value) {
  if (value === undefined || value === null || value === '') return null;
  const id = String(value);
  if (!mongoose.Types.ObjectId.isValid(id)) throw ApiError.badRequest('longQueryId is not a valid id');
  const task = await OptimizationActivity.findById(id).select('activityType').lean();
  if (!task || task.activityType !== 'LONG_QUERY') {
    throw ApiError.badRequest('longQueryId must name a recorded long query');
  }
  return task._id;
}

/**
 * Attach already-created index rows to a long query task.
 *
 * Accepts the ids of INDEX_CREATED activity rows, or of the Manual Index
 * records behind them — the frontend has whichever screen it came from.
 * Returns how many index rows now belong to the task.
 */
async function linkIndexesToLongQuery(longQueryId, { activityIds = [], manualIndexIds = [] } = {}) {
  const valid = (list) =>
    (Array.isArray(list) ? list : [list])
      .map(String)
      .filter((id) => mongoose.Types.ObjectId.isValid(id));

  const acts = valid(activityIds);
  const manual = valid(manualIndexIds);
  if (acts.length || manual.length) {
    await OptimizationActivity.updateMany(
      {
        activityType: 'INDEX_CREATED',
        $or: [{ _id: { $in: acts } }, { manualIndexId: { $in: manual } }],
      },
      { $set: { longQueryId, longQueryLink: { method: 'manual', score: null } } }
    );
  }
  return OptimizationActivity.countDocuments({ activityType: 'INDEX_CREATED', longQueryId });
}

/**
 * Make a long query's linked indexes exactly `activityIds`.
 *
 * Ticked ones are linked; ones that were linked to this query and are no
 * longer ticked are released back to standalone. An index another task owns is
 * never taken from it here — that would silently move a fix between queries.
 * @returns how many indexes the query now has.
 */
async function setLinkedIndexes(longQueryId, activityIds = [], { move = false } = {}) {
  const ids = (Array.isArray(activityIds) ? activityIds : [activityIds])
    .map(String)
    .filter((id) => mongoose.Types.ObjectId.isValid(id));

  await OptimizationActivity.updateMany(
    { activityType: 'INDEX_CREATED', longQueryId, _id: { $nin: ids } },
    { $set: { longQueryId: null, longQueryLink: null } }
  );
  if (ids.length) {
    await OptimizationActivity.updateMany(
      // With move, a ticked index held by another query is taken from it — the
      // dialog shows that holder, so the tick is deliberate.
      { activityType: 'INDEX_CREATED', _id: { $in: ids }, ...(move ? {} : { longQueryId: null }) },
      { $set: { longQueryId, longQueryLink: { method: 'manual', score: null } } }
    );
  }
  return OptimizationActivity.countDocuments({ activityType: 'INDEX_CREATED', longQueryId });
}

/** An index was removed from MongoDB, through any of the drop paths. */
const recordIndexDropped = ({
  databaseName,
  collectionName,
  indexName,
  key = null,
  user,
  auditLog = null,
  manualIndexId = null,
  notes = '',
}) =>
  record({
    activityType: 'INDEX_DROPPED',
    databaseName,
    collectionName,
    subject: indexName,
    subjectDetail: key ? { key } : null,
    manualIndexId,
    auditLogId: auditLog ? auditLog._id : null,
    user,
    notes,
  });

module.exports = {
  setLinkedIndexes,
  record,
  recordIndexCreated,
  recordIndexDropped,
  measurement,
  resolveLongQueryId,
  linkIndexesToLongQuery,
  autoLinkIndex,
  autoLinkLongQuery,
};
