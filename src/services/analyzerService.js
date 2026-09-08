'use strict';

const advisor = require('./indexAdvisor');
const indexService = require('./indexService');
const ApiError = require('../utils/ApiError');

/**
 * Finds slow queries and recommends indexes for them.
 *
 * Three independent sources of evidence, each optional. MongoDB deployments
 * differ in what they allow — Atlas shared tiers (M0/M2/M5) block the database
 * profiler entirely, and some managed providers restrict `$indexStats` — so
 * every capability is probed and degrades to a clear message instead of an
 * error, and the parts that do work keep working.
 *
 *   1. Profiler   — actual slow operations recorded by the server.
 *   2. explain()  — how a specific query would run, right now.
 *   3. $indexStats — which existing indexes are never used.
 */

/** The database being analysed — the target database, or one named by the caller. */
function db(databaseName) {
  return indexService.database(databaseName);
}

/** Collection name out of a profiler namespace like "dba_utility.orders". */
function collectionFromNs(ns = '') {
  const parts = String(ns).split('.');
  return parts.slice(1).join('.');
}

/**
 * Pull the query shape out of a profiler entry. MongoDB has used several
 * layouts over the years and across operation types, so all are handled.
 */
function extractQueryShape(entry = {}) {
  const command = entry.command || {};
  let filter = null;
  let sort = null;

  if (command.filter) filter = command.filter;
  else if (command.q) filter = command.q; // update / delete
  else if (entry.query && !entry.query.filter) filter = entry.query; // legacy
  else if (entry.query && entry.query.filter) filter = entry.query.filter;

  if (command.sort) sort = command.sort;
  else if (entry.query && entry.query.sort) sort = entry.query.sort;

  // Aggregations: use the leading $match / $sort, which is what an index can serve.
  if (!filter && Array.isArray(command.pipeline)) {
    const match = command.pipeline.find((stage) => stage && stage.$match);
    if (match) filter = match.$match;
    const sortStage = command.pipeline.find((stage) => stage && stage.$sort);
    if (sortStage) sort = sortStage.$sort;
  }

  return { filter: filter || {}, sort: sort || null };
}

/**
 * A stable identity for "the same query with different values", so repeated
 * executions collapse into one row instead of hundreds.
 */
function queryShapeKey(collection, filter = {}, sort = null) {
  const walk = (obj) => {
    if (obj === null || typeof obj !== 'object') return '?';
    if (Array.isArray(obj)) return `[${obj.map(walk).join(',')}]`;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${k}:${k.startsWith('$') ? walk(obj[k]) : walk(obj[k])}`)
      .join(',')}}`;
  };
  const sortPart = sort ? Object.entries(sort).map(([k, v]) => `${k}:${v}`).join(',') : '';
  return `${collection}|${walk(filter)}|${sortPart}`;
}

/** Why this operation is considered a problem, and how badly. */
function assessSeverity(entry) {
  const millis = entry.millis || 0;
  const examined = entry.docsExamined ?? entry.docsExamined ?? 0;
  const returned = entry.nreturned ?? entry.nReturned ?? 0;
  const ratio = returned > 0 ? examined / returned : examined;
  const collscan = /COLLSCAN/i.test(entry.planSummary || '');

  const reasons = [];
  if (collscan) reasons.push('full collection scan (COLLSCAN) — no index was used');
  if (ratio >= 100) reasons.push(`examined ${Math.round(ratio)}× more documents than it returned`);
  else if (ratio >= 10) reasons.push(`examined ${Math.round(ratio)}× more documents than it returned`);
  if (millis >= 1000) reasons.push(`took ${millis} ms`);

  let severity = 'low';
  if (collscan || ratio >= 100 || millis >= 1000) severity = 'high';
  else if (ratio >= 10 || millis >= 200) severity = 'medium';

  return { severity, reasons, ratio: Number.isFinite(ratio) ? Math.round(ratio) : 0, collscan };
}

/** Is the profiler usable on this deployment? */
async function getProfilerStatus(databaseName) {
  try {
    const result = await db(databaseName).command({ profile: -1 });
    return {
      supported: true,
      enabled: (result.was || 0) > 0,
      level: result.was || 0,
      slowMs: result.slowms ?? null,
      message:
        (result.was || 0) > 0
          ? `Profiler is ON, recording operations slower than ${result.slowms} ms.`
          : 'Profiler is OFF. Turn it on to start recording slow operations.',
    };
  } catch (err) {
    return {
      supported: false,
      enabled: false,
      level: 0,
      slowMs: null,
      message:
        'This deployment does not allow the database profiler. ' +
        'MongoDB Atlas shared tiers (M0, M2, M5) block it — use the Analyze a query tool below, ' +
        'which works everywhere.',
      error: err.message,
    };
  }
}

/** Turn the profiler on (level 1 = slow operations only) or off. */
async function setProfiler({ enabled, slowMs = 100, databaseName }) {
  try {
    const level = enabled ? 1 : 0;
    await db(databaseName).command({ profile: level, slowms: Number(slowMs) });
    return getProfilerStatus(databaseName);
  } catch (err) {
    throw ApiError.badRequest(
      `Could not change the profiler setting: ${err.message}. ` +
        'Managed MongoDB services often disable this — on Atlas it needs a dedicated cluster (M10 or above).'
    );
  }
}

/**
 * Read recorded slow operations, group them by query shape and attach an index
 * recommendation to each group.
 */
async function getSlowQueries({ minMs = 100, limit = 200, databaseName } = {}) {
  let entries;
  try {
    entries = await db(databaseName)
      .collection('system.profile')
      .find({ millis: { $gte: Number(minMs) }, ns: { $not: /system\.profile|\$cmd/ } })
      .sort({ ts: -1 })
      .limit(Number(limit))
      .toArray();
  } catch (err) {
    return {
      supported: false,
      groups: [],
      message:
        'The profiler collection could not be read on this deployment. ' +
        'Use the Analyze a query tool instead — it works on every tier.',
      error: err.message,
    };
  }

  const byShape = new Map();

  for (const entry of entries) {
    const collection = collectionFromNs(entry.ns);
    if (!collection || collection.startsWith('system.')) continue;

    const { filter, sort } = extractQueryShape(entry);
    if (!filter || Object.keys(filter).length === 0) continue;

    const key = queryShapeKey(collection, filter, sort);
    const assessment = assessSeverity(entry);

    if (!byShape.has(key)) {
      byShape.set(key, {
        key,
        collectionName: collection,
        operation: entry.op || 'query',
        filter,
        sort,
        count: 0,
        totalMs: 0,
        maxMs: 0,
        docsExamined: 0,
        nReturned: 0,
        planSummary: entry.planSummary || '',
        lastSeen: entry.ts || null,
        severity: 'low',
        reasons: [],
      });
    }

    const group = byShape.get(key);
    group.count += 1;
    group.totalMs += entry.millis || 0;
    group.maxMs = Math.max(group.maxMs, entry.millis || 0);
    group.docsExamined += entry.docsExamined || 0;
    group.nReturned += entry.nreturned || 0;
    if (entry.ts && (!group.lastSeen || entry.ts > group.lastSeen)) group.lastSeen = entry.ts;
    if (assessment.severity === 'high' || (assessment.severity === 'medium' && group.severity === 'low')) {
      group.severity = assessment.severity;
    }
    for (const reason of assessment.reasons) {
      if (!group.reasons.includes(reason)) group.reasons.push(reason);
    }
  }

  // Attach a recommendation, using each collection's current indexes.
  const groups = [...byShape.values()];
  const indexCache = new Map();

  for (const group of groups) {
    if (!indexCache.has(group.collectionName)) {
      indexCache.set(
        group.collectionName,
        await indexService.listCollectionIndexes(group.collectionName, databaseName).catch(() => [])
      );
    }
    group.avgMs = Math.round(group.totalMs / group.count);
    group.recommendation = advisor.advise({
      collectionName: group.collectionName,
      filter: group.filter,
      sort: group.sort,
      existingIndexes: indexCache.get(group.collectionName),
    });
  }

  // Worst first: severity, then total time spent.
  const rank = { high: 3, medium: 2, low: 1 };
  groups.sort((a, b) => rank[b.severity] - rank[a.severity] || b.totalMs - a.totalMs);

  return {
    supported: true,
    sampled: entries.length,
    groups,
    message: groups.length
      ? `${groups.length} distinct slow query shape${groups.length === 1 ? '' : 's'} found in ${entries.length} recorded operations.`
      : 'No slow operations recorded yet. Run your application, then refresh.',
  };
}

/**
 * Analyse one query on demand. Works on every deployment: the recommendation
 * comes from the advisor, and `explain()` adds real execution numbers when the
 * server allows it.
 */
async function analyzeQuery({ collectionName, filter = {}, sort = null, databaseName }) {
  const name = indexService.assertSafeCollection(collectionName);
  const existingIndexes = await indexService.listCollectionIndexes(name, databaseName).catch(() => []);

  const recommendation = advisor.advise({ collectionName: name, filter, sort, existingIndexes });

  let execution = null;
  try {
    let cursor = db(databaseName).collection(name).find(filter);
    if (sort) cursor = cursor.sort(sort);
    const plan = await cursor.explain('executionStats');
    const stats = plan.executionStats || {};
    const winning = plan.queryPlanner?.winningPlan || {};
    const stageOf = (node) => (node?.inputStage ? stageOf(node.inputStage) : node?.stage);

    const examined = stats.totalDocsExamined ?? 0;
    const returned = stats.nReturned ?? 0;

    execution = {
      supported: true,
      stage: stageOf(winning) || winning.stage || 'unknown',
      collectionScan: /COLLSCAN/i.test(JSON.stringify(winning)),
      docsExamined: examined,
      keysExamined: stats.totalKeysExamined ?? 0,
      nReturned: returned,
      millis: stats.executionTimeMillis ?? null,
      examinedPerReturned: returned > 0 ? Math.round((examined / returned) * 10) / 10 : examined,
    };
  } catch (err) {
    execution = {
      supported: false,
      message: `explain() is not available here: ${err.message}`,
    };
  }

  return {
    databaseName: indexService.resolveDatabaseName(databaseName),
    collectionName: name,
    filter,
    sort,
    existingIndexes: existingIndexes.map(summariseIndex),
    recommendation,
    execution,
  };
}

function summariseIndex(idx) {
  return {
    name: idx.name,
    key: idx.key,
    unique: !!idx.unique,
    sparse: !!idx.sparse,
    partial: !!idx.partialFilterExpression,
    ttl: idx.expireAfterSeconds !== undefined,
  };
}

/**
 * Which indexes are actually being used. An index that has never been hit
 * still costs write throughput and disk on every insert, so unused ones are
 * worth reviewing.
 */
async function getIndexUsage(databaseName) {
  // Required lazily to avoid a circular import at module load.
  const ManualIndex = require('../models/ManualIndex');
  const database = db(databaseName);
  const resolvedDb = indexService.resolveDatabaseName(databaseName);

  // Which of these indexes this application owns. Dropping one of those has to
  // update its record too, so the page has to be able to tell them apart
  // before the user picks — not only after the request comes back.
  const owned = new Map();
  const records = await ManualIndex.find({
    appliedIndexName: { $ne: '' },
    $or: [{ databaseName: resolvedDb }, { databaseName: '' }],
  })
    .select('_id indexName collectionName appliedIndexName')
    .lean();
  for (const r of records) {
    owned.set(`${r.collectionName}.${r.appliedIndexName}`, {
      _id: String(r._id),
      indexName: r.indexName,
    });
  }
  let collections;
  try {
    collections = (await database.listCollections().toArray())
      .filter((c) => c.type !== 'view' && !c.name.startsWith('system.'))
      .map((c) => c.name);
  } catch (err) {
    throw ApiError.badRequest(`Could not list collections: ${err.message}`);
  }

  const results = [];
  let supported = true;
  let message = '';

  for (const name of collections) {
    try {
      const stats = await database.collection(name).aggregate([{ $indexStats: {} }]).toArray();
      results.push({
        collectionName: name,
        indexes: stats
          .map((s) => ({
            name: s.name,
            key: s.key,
            ops: s.accesses?.ops ?? 0,
            since: s.accesses?.since ?? null,
            unused: (s.accesses?.ops ?? 0) === 0 && s.name !== '_id_',
            // MongoDB's own primary key index can never be dropped.
            protected: s.name === '_id_',
            managedBy: owned.get(`${name}.${s.name}`) || null,
          }))
          .sort((a, b) => a.ops - b.ops),
      });
    } catch (err) {
      supported = false;
      message = `$indexStats is not available on this deployment: ${err.message}`;
      break;
    }
  }

  return {
    supported,
    message: supported
      ? 'Usage counts are since the server last restarted — a low count on a new server is normal.'
      : message,
    collections: results,
  };
}

/**
 * A quick structural pass that needs no special privileges: collection sizes
 * and how many indexes each has. Large collections with nothing but `_id_`
 * are the most likely source of slow queries.
 */
async function getOverview(databaseName) {
  const database = db(databaseName);
  const collections = (await database.listCollections().toArray())
    .filter((c) => c.type !== 'view' && !c.name.startsWith('system.'))
    .map((c) => c.name);

  const rows = await Promise.all(
    collections.map(async (name) => {
      let count = null;
      let size = null;
      try {
        const stats = await database.command({ collStats: name });
        count = stats.count ?? null;
        size = stats.size ?? null;
      } catch {
        try {
          count = await database.collection(name).countDocuments();
        } catch {
          /* leave as null */
        }
      }
      const indexes = await indexService.listCollectionIndexes(name, databaseName).catch(() => []);
      const userIndexes = indexes.filter((i) => i.name !== '_id_');
      return {
        collectionName: name,
        documents: count,
        sizeBytes: size,
        indexCount: userIndexes.length,
        indexes: indexes.map(summariseIndex),
        // Anything sizeable with no index beyond _id_ will scan on every query.
        unindexed: userIndexes.length === 0,
        risk: userIndexes.length === 0 && (count || 0) >= 1000 ? 'high' : userIndexes.length === 0 ? 'medium' : 'low',
      };
    })
  );

  rows.sort((a, b) => (b.documents || 0) - (a.documents || 0));

  return {
    databaseName: indexService.resolveDatabaseName(databaseName),
    collections: rows,
    unindexedCount: rows.filter((r) => r.unindexed).length,
  };
}

/**
 * The one command shape this application will run on request.
 *
 * Deliberately a parser and not an evaluator. Handing a mongo shell string to
 * anything that executes JavaScript would let any expression through, so the
 * text is instead matched against exactly one grammar — a dropIndex on one
 * collection — and every part of it is read out as data. Anything else is a
 * validation error, including a second statement appended to a valid one.
 *
 * The repeated alternation is a quoted string literal, single or double.
 */
const DROP_COMMAND =
  /^\s*db(?:\s*\.\s*getSiblingDB\s*\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\))?\s*\.\s*(?:getCollection\s*\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\)|([A-Za-z_$][\w$]*))\s*\.\s*dropIndex\s*\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\)\s*;?\s*$/;

/** Read a quoted literal back as its string value. */
function unquote(literal) {
  if (literal.startsWith('"')) return JSON.parse(literal);
  // Single-quoted: re-quote it as JSON before parsing, so the escape rules
  // stay JSON's rather than being hand-rolled here.
  const inner = literal.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"');
  return JSON.parse('"' + inner + '"');
}

/**
 * Turn a pasted mongo shell line into the arguments of a drop.
 *
 * Accepts the forms the shell itself produces:
 *   db.getSiblingDB("db").getCollection("coll").dropIndex("name")
 *   db.getCollection("coll").dropIndex("name")
 *   db.coll.dropIndex("name")
 */
function parseDropCommand(command) {
  const text = String(command || '').trim();
  if (!text) throw ApiError.badRequest('A command is required');

  const match = DROP_COMMAND.exec(text);
  if (!match) {
    throw ApiError.badRequest(
      'Only a dropIndex command can be run here, in the form ' +
        'db.getSiblingDB("database").getCollection("collection").dropIndex("indexName")'
    );
  }

  const [, dbLiteral, collLiteral, collBare, nameLiteral] = match;
  const collectionName = collLiteral ? unquote(collLiteral) : collBare;
  const indexName = unquote(nameLiteral);

  if (!collectionName) throw ApiError.badRequest('The command names no collection');
  if (!indexName) throw ApiError.badRequest('The command names no index');

  return {
    // Absent getSiblingDB means the session's own target database.
    databaseName: dbLiteral ? unquote(dbLiteral) : undefined,
    collectionName,
    indexName,
  };
}

/**
 * Drop one index from the database. This is the single drop path in the
 * application: an index it created and one it merely found are removed the
 * same way here, so there is one place to look for what was dropped and why.
 *
 * The two differ only in what else has to happen. An index owned by a Manual
 * Index leaves its definition behind as INACTIVE, and its audit entry is bound
 * to that record. An index nothing owns is simply gone, and its entry carries
 * the key specification instead — the only surviving description of it.
 */
async function dropUnusedIndex({ databaseName, collectionName, indexName, user, req }) {
  // Required lazily to avoid a circular import at module load.
  const ManualIndex = require('../models/ManualIndex');
  const auditService = require('./auditService');

  const resolvedDb = indexService.resolveDatabaseName(databaseName);
  const owner = await ManualIndex.findOne({
    collectionName,
    appliedIndexName: indexName,
    $or: [{ databaseName: resolvedDb }, { databaseName: '' }],
  }).lean();

  const mongoCommand = indexService.dropIndexCommand({
    databaseName: resolvedDb,
    collectionName,
    indexName,
  });

  const dropped = await indexService.dropIndexByName({ databaseName, collectionName, indexName });

  // An index this application created is dropped the same way here as from its
  // own page: the definition survives, so nothing has to be retyped to bring
  // it back, and the audit entry is bound to the record rather than floating
  // free — otherwise the index's own history would lose the event that ended it.
  if (owner) {
    const record = await ManualIndex.findById(owner._id);
    if (record) {
      const previousValues = record.toAuditSnapshot();
      record.applied = false;
      record.appliedIndexName = '';
      record.appliedAt = null;
      record.status = 'INACTIVE';
      record.lastSyncError = '';
      record.updatedBy = user.userName;
      await record.save();

      await auditService.record({
        action: 'DROP',
        index: record,
        user,
        previousValues,
        newValues: record.toAuditSnapshot(),
        req,
        mongoCommand,
        details: `Index "${indexName}" was dropped from ${resolvedDb}.${collectionName} from the Query Analyzer; Manual Index "${record.indexName}" was kept and set to INACTIVE`,
      });

      return {
        databaseName: resolvedDb,
        collectionName,
        ...dropped,
        managedBy: { _id: String(record._id), indexName: record.indexName },
      };
    }
  }

  await auditService.logIndexDrop({
    databaseName: resolvedDb,
    collectionName,
    indexName,
    key: dropped.key,
    user,
    req,
    mongoCommand,
  });

  return { databaseName: resolvedDb, collectionName, ...dropped };
}

module.exports = {
  dropUnusedIndex,
  parseDropCommand,
  getProfilerStatus,
  setProfiler,
  getSlowQueries,
  analyzeQuery,
  getIndexUsage,
  getOverview,
  extractQueryShape,
  queryShapeKey,
  assessSeverity,
  collectionFromNs,
};
