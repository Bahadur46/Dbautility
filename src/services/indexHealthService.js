'use strict';

const clusters = require('../config/clusters');
const { runWithCluster, activeDataConnection } = require('../config/clusterConnections');
const indexService = require('./indexService');
const ManualIndex = require('../models/ManualIndex');
const ApiError = require('../utils/ApiError');

/**
 * Index health for one cluster: indexes nothing uses, indexes another index
 * already covers, and the collections carrying the most weight.
 *
 * Read-only — listCollections, $indexStats and $collStats. Nothing is dropped.
 *
 * A cluster holds hundreds of collections, and reading every one takes minutes
 * on a real cluster (Kamdhenu: ~960 collections). That is far past what a page
 * request can wait for, so the scan runs in the background and its raw result
 * is cached per cluster. A request answers from the cache straight away —
 * filters and search are applied to it, not re-read — and says through `scan`
 * whether a scan is still running so the page can poll.
 *
 * Two limits on what "unused" can mean, surfaced rather than hidden:
 *   - $indexStats counts on the node that answered, since that node last
 *     started. A restart resets it: `restartedAt` says how long it has watched,
 *     and an index is only called unused once its counter is `minDays` old.
 *   - An index idle on that node may still serve reads on another member.
 */

const DEFAULT_MIN_DAYS = 7;
// Gentle on the customer's server: at most DB × COLLECTION aggregations at once.
const DB_CONCURRENCY = 4;
const COLLECTION_CONCURRENCY = 6;
const PER_CALL_TIMEOUT_MS = 15000;
const PER_DB_TIMEOUT_MS = 180000;
const MAX_COLLECTIONS_PER_DB = 500;
const TOP_COLLECTIONS = 200;
const CACHE_TTL_MS = 15 * 60 * 1000;
// How long a request waits for a scan it started before answering "running".
const FIRST_WAIT_MS = 10000;
const DAY_MS = 24 * 60 * 60 * 1000;

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

const keysOf = (spec) => Object.entries(spec || {}).map(([field, direction]) => ({ field, direction }));
const sameJson = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

/** An index a suggestion must never touch: dropping it changes behaviour, not just speed. */
function isProtected(index) {
  return Boolean(index.unique) || (index.expireAfterSeconds !== undefined && index.expireAfterSeconds !== null);
}

/**
 * Redundant indexes on one collection.
 *
 *   duplicate  identical keys and options under another name. Of the pair, the
 *              one used less (then the later name) is reported.
 *   prefix     its keys are a leading prefix, same directions, of another index
 *              with the same collation, and neither side is partial; it is not
 *              unique, sparse or TTL itself. The longer index answers every
 *              query the shorter one does.
 *
 * Only plain ascending/descending keys are compared: a text, hashed or geo key
 * is not interchangeable with anything else.
 */
function findRedundant(indexes, opsByName) {
  const plain = indexes.filter(
    (i) => i.name !== '_id_' && Object.values(i.key || {}).every((d) => d === 1 || d === -1)
  );
  const out = new Map();
  for (const a of plain) {
    for (const b of plain) {
      if (a === b || out.has(a.name)) continue;
      const ak = keysOf(a.key);
      const bk = keysOf(b.key);
      const sameOptions =
        sameJson(a.collation, b.collation) &&
        sameJson(a.partialFilterExpression, b.partialFilterExpression) &&
        Boolean(a.sparse) === Boolean(b.sparse) &&
        Boolean(a.unique) === Boolean(b.unique) &&
        (a.expireAfterSeconds ?? null) === (b.expireAfterSeconds ?? null);

      if (ak.length === bk.length && sameJson(ak, bk) && sameOptions) {
        const aOps = opsByName.get(a.name) || 0;
        const bOps = opsByName.get(b.name) || 0;
        // Report only one of the two, and never the one carrying the traffic.
        if (aOps < bOps || (aOps === bOps && a.name > b.name)) {
          out.set(a.name, { index: a, coveredBy: b, reason: 'duplicate' });
        }
        continue;
      }

      const isPrefix =
        ak.length < bk.length && ak.every((k, i) => k.field === bk[i].field && k.direction === bk[i].direction);
      if (
        isPrefix &&
        !isProtected(a) &&
        !a.sparse &&
        !a.partialFilterExpression &&
        !b.partialFilterExpression &&
        sameJson(a.collation, b.collation)
      ) {
        out.set(a.name, { index: a, coveredBy: b, reason: 'prefix' });
      }
    }
  }
  return [...out.values()];
}

/**
 * One collection: index definitions and usage in one call ($indexStats carries
 * each index's `spec`), and its size in another.
 */
async function readCollection(db, database, name) {
  const col = db.collection(name);
  const [usage, stats] = await Promise.all([
    col.aggregate([{ $indexStats: {} }], { maxTimeMS: PER_CALL_TIMEOUT_MS }).toArray(),
    col
      .aggregate([{ $collStats: { storageStats: {} } }], { maxTimeMS: PER_CALL_TIMEOUT_MS })
      .toArray()
      .then((rows) => (rows[0] && rows[0].storageStats) || null)
      .catch(() => null),
  ]);
  // Servers too old to include `spec` fall back to listing the indexes.
  const indexes = usage.every((u) => u.spec)
    ? usage.map((u) => u.spec)
    : await col.listIndexes().toArray();
  const slim = stats && {
    count: stats.count,
    size: stats.size,
    storageSize: stats.storageSize,
    avgObjSize: stats.avgObjSize,
    totalIndexSize: stats.totalIndexSize,
    nindexes: stats.nindexes,
    indexSizes: stats.indexSizes,
  };
  return {
    database,
    collection: name,
    indexes,
    usage: usage.map((u) => ({ name: u.name, accesses: u.accesses })),
    stats: slim,
  };
}

/** Every collection of one database. Never throws: the error goes on its source. */
async function readDatabase(client, cluster, database) {
  const source = { cluster: cluster.key, database, ok: false, error: null, capped: false, failedCollections: 0 };
  try {
    const db = client.db(database);
    const listed = await withTimeout(
      db.listCollections({ type: 'collection' }, { nameOnly: true }).toArray(),
      PER_CALL_TIMEOUT_MS,
      `${database} collection list`
    );
    const names = listed.map((c) => c.name).filter((n) => !n.startsWith('system.')).sort();
    source.capped = names.length > MAX_COLLECTIONS_PER_DB;
    const collections = await withTimeout(
      mapLimit(names.slice(0, MAX_COLLECTIONS_PER_DB), COLLECTION_CONCURRENCY, (n) =>
        readCollection(db, database, n).catch((err) => ({ database, collection: n, error: err.message }))
      ),
      PER_DB_TIMEOUT_MS,
      database
    );
    source.failedCollections = collections.filter((c) => c.error).length;
    source.ok = true;
    return { source, collections: collections.filter((c) => !c.error) };
  } catch (err) {
    source.error = err.message;
    return { source, collections: [] };
  }
}

/** How long the node has been up, when the user may ask. Null otherwise. */
async function uptimeOf(client) {
  try {
    const status = await withTimeout(
      client.db('admin').command({ serverStatus: 1, repl: 0, metrics: 0, locks: 0, wiredTiger: 0 }),
      PER_CALL_TIMEOUT_MS,
      'serverStatus'
    );
    const seconds = Number(status.uptime);
    return Number.isFinite(seconds)
      ? { uptimeSeconds: seconds, restartedAt: new Date(Date.now() - seconds * 1000).toISOString() }
      : null;
  } catch {
    return null;
  }
}

/** Manual Index records on this cluster, as a lookup by database, collection and name. */
async function manualIndexLookup() {
  try {
    const rows = await ManualIndex.find({})
      .select('_id indexName appliedIndexName databaseName collectionName')
      .lean();
    const map = new Map();
    for (const r of rows) {
      for (const name of [r.appliedIndexName, r.indexName].filter(Boolean)) {
        map.set(`${r.databaseName || ''}|${r.collectionName}|${name}`, String(r._id));
        // A record saved without a database was applied to the default target one.
        if (!r.databaseName) map.set(`*|${r.collectionName}|${name}`, String(r._id));
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Read a whole cluster. The slow part — run once, cached. */
function scanCluster(cluster) {
  return runWithCluster(cluster.key, async () => {
    const client = activeDataConnection().getClient();
    let databases;
    try {
      databases = await withTimeout(indexService.listDatabases(), PER_CALL_TIMEOUT_MS, `${cluster.label} database list`);
    } catch (err) {
      return {
        collections: [],
        manualIds: new Map(),
        uptime: null,
        sources: [{ cluster: cluster.key, database: null, ok: false, error: err.message, capped: false, failedCollections: 0 }],
      };
    }
    const [uptime, manualIds, results] = await Promise.all([
      uptimeOf(client),
      manualIndexLookup(),
      mapLimit(databases, DB_CONCURRENCY, ({ name }) => readDatabase(client, cluster, name)),
    ]);
    return {
      collections: results.flatMap((r) => r.collections),
      manualIds,
      uptime,
      sources: results.map((r) => r.source),
    };
  });
}

// cluster key -> { result, finishedAt, running: Promise|null, startedAt, error }
const cache = new Map();

function startScan(cluster) {
  const entry = cache.get(cluster.key) || {};
  if (entry.running) return entry;
  entry.startedAt = new Date();
  entry.running = scanCluster(cluster)
    .then((result) => {
      entry.result = result;
      entry.finishedAt = new Date();
      entry.error = null;
    })
    .catch((err) => {
      entry.error = err.message;
    })
    .finally(() => {
      entry.running = null;
    });
  cache.set(cluster.key, entry);
  return entry;
}

/** Turn a cached scan into the page's answer, applying this request's filters. */
function buildResponse(cluster, raw, { database, search, minDays }) {
  const ref = { key: cluster.key, label: cluster.label };
  const needle = search && String(search).trim() ? String(search).trim().toLowerCase() : null;
  const matches = (...values) => !needle || values.some((v) => String(v || '').toLowerCase().includes(needle));
  const cutoff = Date.now() - minDays * DAY_MS;
  const manualIdOf = (db, col, name) =>
    raw.manualIds.get(`${db}|${col}|${name}`) || raw.manualIds.get(`*|${col}|${name}`) || null;

  const unused = [];
  const redundant = [];
  const collections = [];
  let protectedCount = 0;
  let totalIndexBytes = 0;

  for (const c of raw.collections) {
    if (database && c.database !== database) continue;
    const sizes = (c.stats && c.stats.indexSizes) || {};
    const usageByName = new Map(c.usage.map((u) => [u.name, u]));
    const opsByName = new Map(c.usage.map((u) => [u.name, Number(u.accesses && u.accesses.ops) || 0]));

    if (c.stats) {
      const indexBytes = Number(c.stats.totalIndexSize) || 0;
      totalIndexBytes += indexBytes;
      if (matches(c.database, c.collection)) {
        const dataBytes = Number(c.stats.size) || 0;
        collections.push({
          cluster: ref,
          database: c.database,
          collection: c.collection,
          count: Number(c.stats.count) || 0,
          sizeBytes: dataBytes,
          storageBytes: Number(c.stats.storageSize) || 0,
          avgObjSize: Number(c.stats.avgObjSize) || 0,
          totalIndexBytes: indexBytes,
          indexCount: Number(c.stats.nindexes) || c.indexes.length,
          indexToDataRatio: dataBytes ? Math.round((indexBytes / dataBytes) * 100) / 100 : null,
          onlyIdIndex: c.indexes.length === 1,
        });
      }
    }

    for (const index of c.indexes) {
      if (index.name === '_id_') continue;
      const stat = usageByName.get(index.name);
      // No usage row means the counter could not be read — not "unused".
      if (!stat || !stat.accesses) continue;
      const ops = Number(stat.accesses.ops) || 0;
      const since = stat.accesses.since ? new Date(stat.accesses.since) : null;
      if (ops !== 0 || !since || since.getTime() > cutoff) continue;
      if (isProtected(index)) {
        protectedCount += 1;
        continue;
      }
      if (!matches(c.database, c.collection, index.name)) continue;
      unused.push({
        cluster: ref,
        database: c.database,
        collection: c.collection,
        indexName: index.name,
        keys: keysOf(index.key),
        sizeBytes: sizes[index.name] ?? null,
        accesses: ops,
        since: since.toISOString(),
        daysTracked: Math.floor((Date.now() - since.getTime()) / DAY_MS),
        manualIndexId: manualIdOf(c.database, c.collection, index.name),
      });
    }

    for (const r of findRedundant(c.indexes, opsByName)) {
      if (!matches(c.database, c.collection, r.index.name, r.coveredBy.name)) continue;
      redundant.push({
        cluster: ref,
        database: c.database,
        collection: c.collection,
        indexName: r.index.name,
        keys: keysOf(r.index.key),
        sizeBytes: sizes[r.index.name] ?? null,
        coveredBy: { indexName: r.coveredBy.name, keys: keysOf(r.coveredBy.key) },
        reason: r.reason,
      });
    }
  }

  unused.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
  redundant.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
  collections.sort((a, b) => b.storageBytes - a.storageBytes);
  const sum = (list) => list.reduce((n, i) => n + (i.sizeBytes || 0), 0);

  return {
    data: { unused, redundant, collections: collections.slice(0, TOP_COLLECTIONS) },
    summary: {
      unusedCount: unused.length,
      unusedBytes: sum(unused),
      redundantCount: redundant.length,
      redundantBytes: sum(redundant),
      protectedCount,
      collections: collections.length,
      totalIndexBytes,
    },
    sources: raw.sources
      .filter((s) => !database || s.database === database || s.database === null)
      .map((s) => ({
        ...s,
        uptimeSeconds: raw.uptime ? raw.uptime.uptimeSeconds : null,
        restartedAt: raw.uptime ? raw.uptime.restartedAt : null,
      })),
  };
}

const EMPTY = {
  data: { unused: [], redundant: [], collections: [] },
  summary: { unusedCount: 0, unusedBytes: 0, redundantCount: 0, redundantBytes: 0, protectedCount: 0, collections: 0, totalIndexBytes: 0 },
  sources: [],
};

/**
 * GET /dashboard/dba/index-health
 *
 * `scan.status`:
 *   ready       the answer is from a finished scan (`generatedAt`).
 *   refreshing  a newer scan is running; the answer is the previous one.
 *   running     the first scan is still running; the answer is empty — poll.
 *   failed      the scan failed (`error`); a previous answer is kept if any.
 */
async function getIndexHealth({ clusterKey, database, search, minDays, refresh }) {
  if (!clusterKey || clusterKey === 'unassigned') {
    throw ApiError.badRequest('cluster is required — index health is read one cluster at a time');
  }
  const cluster = clusters.clusters.find((c) => c.key === clusterKey);
  if (!cluster) throw ApiError.badRequest(`Cluster "${clusterKey}" is not configured`);

  const days = minDays === undefined || minDays === '' ? DEFAULT_MIN_DAYS : Number(minDays);
  if (!Number.isFinite(days) || days < 0) throw ApiError.badRequest('minDays must be a non-negative number');

  let entry = cache.get(cluster.key);
  const stale = !entry || !entry.result || Date.now() - entry.finishedAt > CACHE_TTL_MS;
  const wantsRefresh = String(refresh || '').toLowerCase() === 'true';
  if (stale || wantsRefresh) entry = startScan(cluster);

  // A first scan on a small cluster finishes quickly: wait a little rather
  // than make the page poll for something already nearly done.
  if (entry.running && !entry.result) {
    await Promise.race([entry.running, new Promise((r) => setTimeout(r, FIRST_WAIT_MS))]);
  }

  const status = entry.running
    ? entry.result
      ? 'refreshing'
      : 'running'
    : entry.error
      ? 'failed'
      : 'ready';
  const body = entry.result
    ? buildResponse(cluster, entry.result, { database: database ? String(database) : null, search, minDays: days })
    : EMPTY;

  return {
    ...body,
    scan: {
      status,
      startedAt: entry.startedAt ? entry.startedAt.toISOString() : null,
      generatedAt: entry.finishedAt ? entry.finishedAt.toISOString() : null,
      error: entry.error || null,
    },
  };
}

module.exports = { getIndexHealth, findRedundant, DEFAULT_MIN_DAYS, _cache: cache };
