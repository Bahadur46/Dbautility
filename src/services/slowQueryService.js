'use strict';

const clusters = require('../config/clusters');
const { runWithCluster, activeDataConnection } = require('../config/clusterConnections');
const indexService = require('./indexService');
const longQueryService = require('./longQueryService');
const OptimizationActivity = require('../models/OptimizationActivity');
const ApiError = require('../utils/ApiError');

/**
 * Slow queries as MongoDB's profiler saw them, grouped into query shapes.
 *
 * Strictly read-only. Each database's `system.profile` is read with a bounded
 * find, and the profiling level is read with `{ profile: -1 }`, which reports
 * the setting without changing it. Nothing here turns the profiler on: that
 * costs the customer's server, and is a decision for whoever runs it.
 *
 * One slow database must not sink the panel, so every database is read with
 * its own time limit, and a failure is reported in `sources` next to the ones
 * that worked rather than failing the request.
 */

const DEFAULT_MIN_MS = 100;
const PER_DB_DOC_CAP = 5000;
const PER_DB_TIMEOUT_MS = 8000;
// Databases read at once per cluster. Clusters themselves run in parallel.
const DB_CONCURRENCY = 8;

/** Run `worker` over `items`, at most `limit` at a time. */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The grouping key for one profile entry. queryHash identifies a query shape
 * across executions; planCacheKey is the next best; failing both, the
 * namespace, operation and the fields the filter uses — the same fields the
 * long query's subject names, so one shape is one group.
 */
function groupKeyOf(doc, parsed) {
  if (doc.queryHash) return { key: `h:${doc.queryHash}`, queryHash: doc.queryHash };
  if (doc.planCacheKey) return { key: `p:${doc.planCacheKey}`, queryHash: null };
  const shape = parsed ? longQueryService.describe(parsed) : `${doc.op} ${doc.ns}`;
  return { key: `s:${doc.ns}|${doc.op}|${shape}`, queryHash: null };
}

/** Read one database's profile. Never throws: the error goes into its source row. */
async function readDatabase(client, cluster, database, { start, end, minMs }) {
  const source = { cluster: cluster.key, database, profilingLevel: null, slowms: null, ok: false, error: null };
  try {
    const db = client.db(database);
    const status = await withTimeout(db.command({ profile: -1 }), PER_DB_TIMEOUT_MS, database);
    source.profilingLevel = status.was;
    source.slowms = status.slowms ?? null;

    const filter = { millis: { $gte: minMs }, ns: { $not: /\.system\./ } };
    if (start || end) {
      filter.ts = {};
      if (start) filter.ts.$gte = start;
      if (end) filter.ts.$lte = end;
    }
    const docs = await db
      .collection('system.profile')
      .find(filter, { maxTimeMS: PER_DB_TIMEOUT_MS })
      .sort({ ts: -1 })
      .limit(PER_DB_DOC_CAP)
      .toArray();
    source.ok = true;
    source.scanned = docs.length;
    source.capped = docs.length === PER_DB_DOC_CAP;
    return { source, docs };
  } catch (err) {
    source.error = err.message;
    return { source, docs: [] };
  }
}

/** Every database on one cluster's data server, read under that cluster. */
function readCluster(cluster, scope) {
  return runWithCluster(cluster.key, async () => {
    let databases;
    try {
      databases = scope.database
        ? [{ name: scope.database }]
        : await withTimeout(indexService.listDatabases(), PER_DB_TIMEOUT_MS, `${cluster.label} database list`);
    } catch (err) {
      return [{ cluster, source: { cluster: cluster.key, database: null, profilingLevel: null, slowms: null, ok: false, error: err.message }, docs: [] }];
    }
    const client = activeDataConnection().getClient();
    return mapLimit(databases, DB_CONCURRENCY, async ({ name }) => ({
      cluster,
      ...(await readDatabase(client, cluster, name, scope)),
    }));
  });
}

/** Fold profile entries into groups. */
function groupEntries(results) {
  const groups = new Map();
  for (const { cluster, docs } of results) {
    for (const doc of docs) {
      let parsed = null;
      try {
        parsed = longQueryService.parseOp(doc);
      } catch {
        // An entry the parser cannot place (no collection) still counts.
      }
      const { key, queryHash } = groupKeyOf(doc, parsed);
      const fullKey = `${cluster.key}|${key}`;
      let g = groups.get(fullKey);
      if (!g) {
        const [database, ...rest] = String(doc.ns || '').split('.');
        g = {
          queryHash,
          cluster: { key: cluster.key, label: cluster.label },
          database: parsed ? parsed.databaseName : database,
          collection: parsed ? parsed.collectionName : rest.join('.'),
          op: parsed ? parsed.operation : doc.op,
          shape: parsed ? longQueryService.describe(parsed) : `${doc.op} ${doc.ns}`,
          count: 0,
          totalMs: 0,
          maxMs: 0,
          docsExamined: 0,
          keysExamined: 0,
          returned: 0,
          firstSeen: doc.ts,
          lastSeen: doc.ts,
          planSummary: doc.planSummary || '',
          sampleOp: doc,
        };
        groups.set(fullKey, g);
      }
      const ms = Number(doc.millis) || 0;
      g.count += 1;
      g.totalMs += ms;
      g.docsExamined += Number(doc.docsExamined) || 0;
      g.keysExamined += Number(doc.keysExamined) || 0;
      g.returned += Number(doc.nreturned) || 0;
      if (doc.ts < g.firstSeen) g.firstSeen = doc.ts;
      if (doc.ts > g.lastSeen) g.lastSeen = doc.ts;
      if (ms >= g.maxMs) {
        // The slowest run is the sample: it is the one worth recording.
        g.maxMs = ms;
        g.sampleOp = doc;
        g.planSummary = doc.planSummary || g.planSummary;
      }
    }
  }
  return [...groups.values()];
}

const avg = (sum, n) => (n ? Math.round(sum / n) : 0);

/** GET /dashboard/dba/slow-queries */
async function getSlowQueries({ clusterKey, start, end, minMs, search, tracked, database, page = 1, limit = 20 }) {
  const min = minMs === undefined || minMs === '' ? DEFAULT_MIN_MS : Number(minMs);
  if (!Number.isFinite(min) || min < 0) throw ApiError.badRequest('minMs must be a non-negative number');
  const trackedFilter = tracked === undefined || tracked === '' ? null : String(tracked).toLowerCase();
  if (trackedFilter !== null && trackedFilter !== 'true' && trackedFilter !== 'false') {
    throw ApiError.badRequest('tracked must be true or false');
  }
  // Unassigned activity has no cluster to read a profiler from.
  if (clusterKey === 'unassigned') throw ApiError.badRequest('Slow queries are read per cluster');

  const scope = { start, end, minMs: min, database: database ? String(database) : null };
  const inScope = clusters.clusters.filter((c) => !clusterKey || c.key === clusterKey);

  const perCluster = await Promise.all(inScope.map((c) => readCluster(c, scope)));
  const results = perCluster.flat();
  let groups = groupEntries(results);

  // Which shapes are already on the board. Matched by queryHash within the
  // cluster; a group without one cannot be matched and reads as untracked.
  const hashes = [...new Set(groups.map((g) => g.queryHash).filter(Boolean))];
  const trackedRows = hashes.length
    ? await OptimizationActivity.find({
        activityType: 'LONG_QUERY',
        status: { $ne: 'IGNORED' },
        'subjectDetail.queryHash': { $in: hashes },
      })
        .select('_id status cluster subjectDetail.queryHash timestamp')
        .sort({ timestamp: -1 })
        .lean()
    : [];
  const trackedBy = new Map();
  for (const row of trackedRows) {
    const k = `${row.cluster}|${row.subjectDetail.queryHash}`;
    if (!trackedBy.has(k)) trackedBy.set(k, { _id: String(row._id), status: row.status });
  }

  groups = groups.map((g) => ({
    queryHash: g.queryHash,
    cluster: g.cluster,
    database: g.database,
    collection: g.collection,
    op: g.op,
    shape: g.shape,
    count: g.count,
    avgMs: avg(g.totalMs, g.count),
    maxMs: g.maxMs,
    totalMs: g.totalMs,
    lastSeen: new Date(g.lastSeen).toISOString(),
    firstSeen: new Date(g.firstSeen).toISOString(),
    avgDocsExamined: avg(g.docsExamined, g.count),
    avgKeysExamined: avg(g.keysExamined, g.count),
    avgReturned: avg(g.returned, g.count),
    planSummary: g.planSummary,
    collscan: /COLLSCAN/.test(g.planSummary),
    sampleOp: g.sampleOp,
    tracked: g.queryHash ? trackedBy.get(`${g.cluster.key}|${g.queryHash}`) || null : null,
  }));

  if (search && String(search).trim()) {
    const needle = String(search).trim().toLowerCase();
    groups = groups.filter((g) =>
      [g.shape, g.database, g.collection, g.queryHash, g.planSummary].some((v) =>
        String(v || '').toLowerCase().includes(needle)
      )
    );
  }

  const summary = {
    groups: groups.length,
    executions: groups.reduce((n, g) => n + g.count, 0),
    collscanGroups: groups.filter((g) => g.collscan).length,
    untrackedGroups: groups.filter((g) => !g.tracked).length,
  };

  if (trackedFilter !== null) {
    const want = trackedFilter === 'true';
    groups = groups.filter((g) => Boolean(g.tracked) === want);
  }
  groups.sort((a, b) => b.totalMs - a.totalMs);

  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 20));
  const total = groups.length;
  const totalPages = Math.max(1, Math.ceil(total / safeLimit));
  const current = Math.min(Math.max(1, Number(page) || 1), totalPages);

  return {
    data: groups.slice((current - 1) * safeLimit, current * safeLimit),
    meta: {
      page: current,
      limit: safeLimit,
      total,
      totalPages,
      hasNextPage: current < totalPages,
      hasPrevPage: current > 1,
    },
    summary,
    sources: results.map((r) => r.source),
  };
}

/**
 * One database's profiler state, read-only: the level from { profile: -1 },
 * and what system.profile holds. Never throws — the error goes on the row.
 */
async function readProfilerStatus(client, cluster, database) {
  const row = {
    cluster: { key: cluster.key, label: cluster.label },
    database,
    profilingLevel: null,
    slowms: null,
    sampleRate: null,
    profileCollection: null,
    lastEntryAt: null,
    ok: false,
    error: null,
  };
  try {
    const db = client.db(database);
    const status = await withTimeout(db.command({ profile: -1 }), PER_DB_TIMEOUT_MS, database);
    row.profilingLevel = status.was;
    row.slowms = status.slowms ?? null;
    row.sampleRate = status.sampleRate ?? null;

    const [info] = await db.listCollections({ name: 'system.profile' }, { nameOnly: false }).toArray();
    if (info) {
      const profile = db.collection('system.profile');
      const [stats] = await profile
        .aggregate([{ $collStats: { storageStats: {} } }], { maxTimeMS: PER_DB_TIMEOUT_MS })
        .toArray()
        .catch(() => []);
      const [newest] = await profile
        .find({}, { projection: { ts: 1 }, maxTimeMS: PER_DB_TIMEOUT_MS })
        .sort({ $natural: -1 })
        .limit(1)
        .toArray();
      row.profileCollection = {
        exists: true,
        capped: Boolean(info.options && info.options.capped),
        sizeBytes: stats && stats.storageStats ? stats.storageStats.size : null,
        maxBytes: (info.options && info.options.size) || (stats && stats.storageStats && stats.storageStats.maxSize) || null,
        count: stats && stats.storageStats ? stats.storageStats.count : await profile.estimatedDocumentCount(),
      };
      row.lastEntryAt = newest && newest.ts ? new Date(newest.ts).toISOString() : null;
    } else {
      row.profileCollection = { exists: false, capped: false, sizeBytes: null, maxBytes: null, count: 0 };
    }
    row.ok = true;
  } catch (err) {
    row.error = err.message;
  }
  return row;
}

/** GET /dashboard/dba/profiler/status */
async function getProfilerStatus({ clusterKey, search }) {
  if (clusterKey === 'unassigned') throw ApiError.badRequest('Profiler status is read per cluster');
  const inScope = clusters.clusters.filter((c) => !clusterKey || c.key === clusterKey);

  const perCluster = await Promise.all(
    inScope.map((cluster) =>
      runWithCluster(cluster.key, async () => {
        let databases;
        try {
          databases = await withTimeout(indexService.listDatabases(), PER_DB_TIMEOUT_MS, `${cluster.label} database list`);
        } catch (err) {
          return [{ cluster: { key: cluster.key, label: cluster.label }, database: null, profilingLevel: null, slowms: null,
            sampleRate: null, profileCollection: null, lastEntryAt: null, ok: false, error: err.message }];
        }
        const client = activeDataConnection().getClient();
        return mapLimit(databases, DB_CONCURRENCY, ({ name }) => readProfilerStatus(client, cluster, name));
      })
    )
  );

  let rows = perCluster.flat();
  if (search && String(search).trim()) {
    const needle = String(search).trim().toLowerCase();
    rows = rows.filter((r) => [r.database, r.cluster.label, r.cluster.key].some((v) => String(v || '').toLowerCase().includes(needle)));
  }

  // Unreadable last, then off before on (off is what needs attention), then name.
  const bucket = (r) => (!r.ok ? 2 : r.profilingLevel > 0 ? 1 : 0);
  rows.sort((a, b) => bucket(a) - bucket(b) || String(a.database).localeCompare(String(b.database)) || a.cluster.key.localeCompare(b.cluster.key));

  const summary = {
    databases: rows.length,
    on: rows.filter((r) => r.ok && r.profilingLevel > 0).length,
    off: rows.filter((r) => r.ok && !(r.profilingLevel > 0)).length,
    unreadable: rows.filter((r) => !r.ok).length,
  };
  return { data: rows, summary };
}

module.exports = { getSlowQueries, getProfilerStatus, groupEntries, DEFAULT_MIN_MS, PER_DB_DOC_CAP };
