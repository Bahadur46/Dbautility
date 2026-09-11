'use strict';

const OptimizationActivity = require('../models/OptimizationActivity');
const clusters = require('../config/clusters');
const ApiError = require('../utils/ApiError');

/**
 * Everything the DBA Optimization Dashboard reads.
 *
 * The date window arrives as explicit `from`/`to` instants rather than a preset
 * name. The browser has already resolved "this week" in the reader's own
 * timezone, and a server recomputing it from the word would disagree with the
 * page by up to a day whenever the two sit in different zones.
 *
 * One rule runs through the file: every figure comes out of the same window and
 * the same cluster scope, built once by `parseBounds` and `baseFilter` and
 * shared — so a card can never disagree with the table underneath it.
 */

// An empty cluster means every cluster, which is the view the dashboard opens
// on; UNASSIGNED selects the entries that belong to no cluster at all.
const ALL_CLUSTERS = 'all';
const UNASSIGNED = 'unassigned';

const ACTIVITY_TYPES = OptimizationActivity.ACTIVITY_TYPES;

// The key each activity type is counted under in the summary payload. The
// frontend reads the same mapping from its own constants file; the two are a
// contract, so neither may be renamed without the other.
const METRIC_KEYS = {
  LONG_QUERY: 'longQueries',
  INDEX_CREATED: 'indexCreated',
  INDEX_DROPPED: 'indexDropped',
  API_OPTIMIZATION: 'apiOptimizations',
};

/**
 * A pair of ISO instants into a Mongo range, or null when unbounded.
 *
 * "All time" is a real choice on this dashboard, so an absent bound is not an
 * error — it means no limit on that side.
 */
function parseBounds(from, to) {
  const parse = (value, name) => {
    if (value === undefined || value === null || value === '') return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw ApiError.badRequest(`Invalid ${name}`);
    return date;
  };

  const start = parse(from, 'from');
  const end = parse(to, 'to');
  if (start && end && start > end) throw ApiError.badRequest('from must not be after to');
  return { start, end };
}

/**
 * Validate an optional cluster into a key, or null for every cluster.
 *
 * Resolved through the cluster registry rather than passed to Mongo as typed,
 * so the parameter can only ever select a configured cluster — an unknown one
 * is a 400, not a silently empty dashboard that looks like a quiet week.
 */
function parseClusterKey(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === ALL_CLUSTERS) return null;
  if (raw === UNASSIGNED) return UNASSIGNED;
  // Accepts the display label too ("DotIn"), like every other cluster input.
  const key = clusters.normalizeKey(raw);
  if (!key) {
    const known = clusters.listPublic().map((c) => c.key);
    throw ApiError.badRequest(
      `Unknown cluster "${value}". Use one of: ${[ALL_CLUSTERS, ...known, UNASSIGNED].join(', ')}`
    );
  }
  return key;
}

/** Validate an optional activity type filter. '' / 'ALL' means every type. */
function parseType(value) {
  if (!value) return null;
  const type = String(value).trim().toUpperCase();
  if (type === 'ALL') return null;
  if (!ACTIVITY_TYPES.includes(type)) {
    throw ApiError.badRequest(
      `Unknown activity type "${value}". Use one of: ALL, ${ACTIVITY_TYPES.join(', ')}`
    );
  }
  return type;
}

/**
 * The cluster + date scope every dashboard query shares.
 *
 * `clusterKey` null means every cluster. That is safe here in a way it is not
 * for the audit trail, because sign-in is not cluster-wise — one account signs
 * in once for the whole deployment and then picks a cluster, so a user who can
 * see the all-cluster total can already reach every one of those clusters by
 * switching to it. It is also the only place the fan-out can happen: a session
 * token names exactly one cluster, so the browser cannot assemble a
 * cross-cluster total without thrashing the session.
 */
function baseFilter({
  clusterKey,
  start,
  end,
  activityType,
  databaseName,
  collectionName,
  status,
  indexType,
  search,
}) {
  const filter = {};
  if (clusterKey === UNASSIGNED) filter.cluster = '';
  else if (clusterKey) filter.cluster = String(clusterKey);

  // Either bound may be absent — "all time" has neither.
  if (start || end) {
    filter.timestamp = {};
    if (start) filter.timestamp.$gte = start;
    if (end) filter.timestamp.$lte = end;
  }

  if (activityType) filter.activityType = activityType;
  // String(): the extended query parser turns ?databaseName[$ne]= into an
  // object, which would otherwise reach Mongo as an operator.
  if (databaseName) filter.databaseName = String(databaseName);
  if (collectionName) filter.collectionName = String(collectionName);
  if (status) filter.status = String(status).toUpperCase();
  // The index kind, as it was recorded on the activity — SINGLE, COMPOUND, TTL.
  if (indexType) filter['subjectDetail.indexType'] = String(indexType).toUpperCase();

  // One box over the fields a reader would recognise a row by. Escaped before
  // it becomes a regex: an index name may legitimately contain `.` or `$`, and
  // a pasted `(` would otherwise fail as an invalid expression rather than
  // matching nothing.
  if (search && String(search).trim()) {
    const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(escaped, 'i');
    filter.$or = [
      { subject: rx },
      { databaseName: rx },
      { collectionName: rx },
      { userName: rx },
      { notes: rx },
    ];
  }

  return filter;
}

/** Counts per activity type under the frontend's metric names, zeros included. */
async function totalsFor(filter) {
  const rows = await OptimizationActivity.aggregate([
    { $match: filter },
    { $group: { _id: '$activityType', count: { $sum: 1 } } },
  ]);

  const totals = { all: 0 };
  for (const type of ACTIVITY_TYPES) totals[METRIC_KEYS[type]] = 0;
  for (const row of rows) {
    if (METRIC_KEYS[row._id]) totals[METRIC_KEYS[row._id]] = row.count;
    totals.all += row.count;
  }
  return totals;
}

const round1 = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : null);
const roundInt = (v) => (typeof v === 'number' ? Math.round(v) : null);

/**
 * Rows that carry a real improvement figure.
 *
 * `$ifNull` is load-bearing: in an aggregation expression a MISSING field is
 * not equal to null, so `{ $ne: ['$improvementPercent', null] }` alone counts
 * every row that never had the field — a backfilled one, or anything written
 * before the field existed — as a measured 0% improvement, which drags the
 * average down and reports a reading where there is none.
 *
 * Index drops are excluded here rather than filtered out earlier because they
 * still belong in the execution-time and documents-examined averages.
 */
const MEASURED_IMPROVEMENT = {
  $and: [
    { $ne: ['$activityType', 'INDEX_DROPPED'] },
    { $ne: [{ $ifNull: ['$improvementPercent', null] }, null] },
  ],
};

/**
 * The performance panel.
 *
 * Only APPLIED work is averaged. A pending or failed optimisation has not
 * changed how the database behaves, and averaging its intended "after" in would
 * overstate the gain.
 *
 * Index drops are excluded from the improvement figure specifically. They trade
 * read speed for write throughput and storage, so their "after" is legitimately
 * slower — counting them as regressions would misread the intent. They still
 * count towards the execution-time and documents-examined averages, which
 * describe what the database is doing rather than whether it got faster.
 */
async function performanceFor(filter) {
  const applied = { ...filter, status: 'APPLIED' };

  const [row] = await OptimizationActivity.aggregate([
    { $match: applied },
    {
      $group: {
        _id: null,
        appliedCount: { $sum: 1 },
        // $avg ignores nulls, so an unmeasured activity neither counts as zero
        // nor drags the average down.
        avgExecMsBefore: { $avg: '$before.executionTimeMs' },
        avgExecMsAfter: { $avg: '$after.executionTimeMs' },
        docsExaminedBefore: { $avg: '$before.documentsExamined' },
        docsExaminedAfter: { $avg: '$after.documentsExamined' },
        queriesOptimized: {
          $sum: { $cond: [{ $ne: ['$activityType', 'INDEX_DROPPED'] }, 1, 0] },
        },
        improvementSum: {
          $sum: { $cond: [MEASURED_IMPROVEMENT, '$improvementPercent', 0] },
        },
        improvementCount: {
          $sum: { $cond: [MEASURED_IMPROVEMENT, 1, 0] },
        },
        servedByIndex: {
          // $ifNull collapses both "absent" and "null" to '' before the test.
          // Without it a row that recorded no index counts as index-served: in
          // an aggregation expression a MISSING field is not equal to null, so
          // a bare { $ne: ['$after.indexUsed', ''] } is true for every entry
          // that never had the field — which is every backfilled one.
          $sum: { $cond: [{ $ne: [{ $ifNull: ['$after.indexUsed', ''] }, ''] }, 1, 0] },
        },
      },
    },
  ]);

  if (!row || !row.appliedCount) {
    return {
      queriesOptimized: 0,
      avgExecMsBefore: null,
      avgExecMsAfter: null,
      avgImprovementPct: null,
      docsExaminedBefore: null,
      docsExaminedAfter: null,
      indexUsagePct: null,
      memoryImpactPct: null,
      cpuImpactPct: null,
    };
  }

  return {
    queriesOptimized: row.queriesOptimized,
    avgExecMsBefore: roundInt(row.avgExecMsBefore),
    avgExecMsAfter: roundInt(row.avgExecMsAfter),
    avgImprovementPct: row.improvementCount
      ? round1(row.improvementSum / row.improvementCount)
      : null,
    docsExaminedBefore: roundInt(row.docsExaminedBefore),
    docsExaminedAfter: roundInt(row.docsExaminedAfter),
    indexUsagePct: round1((row.servedByIndex / row.appliedCount) * 100),
    // Nothing measures these. The optimisation record holds execution time and
    // documents examined, taken from the query plan; memory residency and CPU
    // are properties of the server over time, not of one optimisation, and
    // MongoDB does not attribute either to the change that caused it.
    // Reporting null lets the panel say "not measured" — a 0 here would read as
    // "measured, and it made no difference", which is a different claim and an
    // unfounded one.
    memoryImpactPct: null,
    cpuImpactPct: null,
  };
}

/**
 * GET /dashboard/dba/summary — the KPI cards and the performance panel.
 *
 * `previous` is the same totals over the window the client resolved as the
 * preceding period, and is null when the range is unbounded: there is no period
 * before "all time", and the cards show no change rather than a made-up one.
 */
async function getSummary({ clusterKey, start, end, previousStart, previousEnd }) {
  const filter = baseFilter({ clusterKey, start, end });

  const [totals, previous, performance, byCluster, byClient] = await Promise.all([
    totalsFor(filter),
    previousStart && previousEnd
      ? totalsFor(baseFilter({ clusterKey, start: previousStart, end: previousEnd }))
      : Promise.resolve(null),
    performanceFor(filter),
    // Each category split across the clusters that hold it, so "9 index drops"
    // can be followed by "…and where". It rides on the summary rather than on a
    // request of its own because the breakdown chart draws it beside
    // `totals` — one window, one cluster scope, fetched once, so the parts can
    // never be of a different period than the whole they sit under.
    splitByCluster(filter),
    // The same idea for API work, which is grouped by customer rather than by
    // cluster: an endpoint is made cheaper *for someone*, and that is the split
    // worth seeing under its card.
    splitByClient(filter),
  ]);

  return { totals, previous, performance, byCluster, byClient };
}

/**
 * API optimisations tallied by the client they were done for.
 *
 * Only API work records a client — a slow query belongs to a database, not to a
 * customer — so this counts that one activity type and nothing else. Entries
 * with no client are their own bucket rather than dropped, so the parts still
 * add up to the API Optimisations card above them.
 */
async function splitByClient(filter) {
  const rows = await OptimizationActivity.aggregate([
    { $match: { ...filter, activityType: 'API_OPTIMIZATION' } },
    { $group: { _id: { client: '$clientName' }, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  return rows.map((row) => {
    const name = (row._id.client || '').trim();
    return { key: name || UNASSIGNED, label: name || 'No client named', count: row.count };
  });
}

/**
 * Per-cluster tallies under one filter, as a roster-ordered array.
 *
 * Totals use the same metric names as the summary cards, so a caller reads
 * `longQueries` the same way wherever it came from.
 */
async function splitByCluster(filter) {
  const rows = await OptimizationActivity.aggregate([
    { $match: filter },
    {
      $group: {
        _id: { cluster: '$cluster', activityType: '$activityType' },
        count: { $sum: 1 },
      },
    },
  ]);

  const blankTotals = () => {
    const out = { all: 0 };
    for (const type of ACTIVITY_TYPES) out[METRIC_KEYS[type]] = 0;
    return out;
  };

  // Every defined cluster gets an entry — configured or not, with activity or
  // not — so a caller can render the full roster without its own copy of it.
  const byCluster = new Map(
    clusters.listAll().map((c) => [c.key, { key: c.key, label: c.label, totals: blankTotals() }])
  );

  for (const row of rows) {
    // Entries belonging to no cluster — written in single-database mode, or
    // before the field existed — are a real bucket rather than a gap, so the
    // parts still add up to the total above them. Same for a cluster since
    // removed from the roster: the work happened, and dropping it would leave
    // a total nothing accounts for.
    const bucket = row._id.cluster || UNASSIGNED;
    if (!byCluster.has(bucket)) {
      byCluster.set(bucket, {
        key: bucket,
        label: bucket === UNASSIGNED ? 'Unassigned' : bucket,
        totals: blankTotals(),
      });
    }

    const entry = byCluster.get(bucket);
    const metric = METRIC_KEYS[row._id.activityType];
    entry.totals.all += row.count;
    if (metric) entry.totals[metric] += row.count;
  }

  return [...byCluster.values()];
}

// The activities whose subject really is an index name.
const INDEX_ACTIVITIES = new Set(['INDEX_CREATED', 'INDEX_DROPPED']);

/**
 * One stored activity as the table renders it.
 *
 * The shape is flattened here rather than in the browser so the table, the
 * detail modal and the CSV a future export writes all read the same row.
 */
function toRow(doc) {
  const cluster = doc.cluster
    ? { key: doc.cluster, label: doc.clusterLabel || doc.cluster }
    : null;

  return {
    _id: String(doc._id),
    timestamp: doc.timestamp ? doc.timestamp.toISOString() : null,
    database: doc.databaseName || '',
    // API work is not tied to one collection; an em dash reads better in the
    // column than an empty cell, which looks like missing data.
    collection: doc.activityType === 'API_OPTIMIZATION' ? '—' : doc.collectionName || '',
    activityType: doc.activityType,
    target: doc.subject,
    // The index this row is about, for the table's "Index Name" column. Only
    // the two index activities have one: a long-query rewrite or an API change
    // names a query shape or an endpoint, which is `target`, and calling that
    // an index name in a column header would be a plain untruth.
    indexName: INDEX_ACTIVITIES.has(doc.activityType) ? doc.subject : null,
    targetDetail: doc.subjectDetail || null,
    beforeMs: doc.before ? doc.before.executionTimeMs : null,
    afterMs: doc.after ? doc.after.executionTimeMs : null,
    // Reported rather than recomputed on render, so the table, the KPI change
    // and the performance panel can never disagree about one row.
    improvementPct: doc.improvementPercent,
    docsExaminedBefore: doc.before ? doc.before.documentsExamined : null,
    docsExaminedAfter: doc.after ? doc.after.documentsExamined : null,
    indexUsed: (doc.after && doc.after.indexUsed) || null,
    user: doc.userName,
    // Named for the columns that read them. An activity is an event: the person
    // who performed it is who the row was "created by", and the moment it
    // happened is when it was last updated — there is no later edit, because
    // the record is never rewritten.
    createdBy: doc.userName,
    clientName: doc.clientName || '',
    updatedAt: doc.timestamp ? doc.timestamp.toISOString() : null,
    // The manual index record behind this activity, when there is one. It is
    // what the list's Actions column opens. Null for a drop of an index nothing
    // here manages, and for the two categories that touch no index at all —
    // the row still lists, it just has nowhere to go.
    manualIndexId: doc.manualIndexId ? String(doc.manualIndexId) : null,
    notes: doc.notes || '',
    // In the all-clusters view the row is ambiguous without it.
    cluster,
    status: doc.status,
  };
}

/** GET /dashboard/dba/activities — the recent-activity table. */
async function getActivities({
  clusterKey,
  start,
  end,
  activityType,
  databaseName,
  collectionName,
  status,
  indexType,
  search,
  page = 1,
  limit = 10,
}) {
  const filter = baseFilter({
    clusterKey,
    start,
    end,
    activityType: parseType(activityType),
    databaseName,
    collectionName,
    status,
    indexType,
    search,
  });

  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 10));
  const requested = Math.max(1, Number(page) || 1);

  const total = await OptimizationActivity.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(total / safeLimit));
  // A filter change can leave the client asking for page 4 of a 2-page result.
  // Clamping returns the last page rather than an empty one, which reads as
  // "no activity" when there is plenty.
  const current = Math.min(requested, totalPages);

  const docs = await OptimizationActivity.find(filter)
    .sort({ timestamp: -1 })
    .skip((current - 1) * safeLimit)
    .limit(safeLimit);

  return {
    data: docs.map(toRow),
    meta: {
      page: current,
      limit: safeLimit,
      total,
      totalPages,
      hasNextPage: current < totalPages,
      hasPrevPage: current > 1,
    },
  };
}

/**
 * GET /dashboard/dba/range-counts — the count behind each date card.
 *
 * One request for every preset rather than one per preset, so opening the
 * dashboard does not fan out into five near-identical count queries. The bounds
 * come from the client because it resolved them in the reader's timezone.
 */
async function getRangeCounts(ranges, { clusterKey }) {
  if (!Array.isArray(ranges)) throw ApiError.badRequest('ranges must be an array');
  if (ranges.length > 12) throw ApiError.badRequest('At most 12 ranges may be counted at once');

  const counts = {};
  await Promise.all(
    ranges.map(async (entry) => {
      const key = String((entry && entry.key) || '').trim();
      if (!key) throw ApiError.badRequest('Every range needs a key');
      const { start, end } = parseBounds(entry.from, entry.to);
      counts[key] = await OptimizationActivity.countDocuments(
        baseFilter({ clusterKey, start, end })
      );
    })
  );

  return { counts };
}

/**
 * GET /dashboard/dba/cluster-counts — how much of the range sits on each cluster.
 *
 * Deliberately unscoped by cluster: this is what makes the cluster chips worth
 * clicking, so each has to keep saying how much work it holds while another one
 * is open. Every configured cluster appears whether or not it has activity — a
 * cluster missing from the strip reads as "not configured" rather than "quiet
 * this week".
 */
async function getClusterCounts({ start, end }) {
  // Grouped by both dimensions at once. The chips need the per-cluster totals
  // and the breakdown chart needs each category split by cluster; deriving both
  // from one pass keeps them from disagreeing, and costs one query rather than
  // one per category.
  const rows = await OptimizationActivity.aggregate([
    { $match: baseFilter({ start, end }) },
    {
      $group: {
        _id: { cluster: '$cluster', activityType: '$activityType' },
        count: { $sum: 1 },
      },
    },
  ]);

  // A per-cluster tally under the same metric names the summary card totals
  // use, so a caller reads "longQueries" the same way wherever it came from.
  const blankTotals = () => {
    const out = { all: 0 };
    for (const type of ACTIVITY_TYPES) out[METRIC_KEYS[type]] = 0;
    return out;
  };

  // Every defined cluster gets an entry — configured or not, with activity or
  // not — so a caller can render the full roster without its own copy of it.
  const roster = clusters.listAll();
  const byCluster = new Map(
    roster.map((c) => [c.key, { key: c.key, label: c.label, totals: blankTotals() }])
  );

  const counts = { all: 0 };
  for (const key of byCluster.keys()) counts[key] = 0;

  for (const row of rows) {
    const key = row._id.cluster || '';
    const metric = METRIC_KEYS[row._id.activityType];

    counts.all += row.count;

    // Entries belonging to no cluster — written in single-database mode, or
    // before the field existed — are a real bucket rather than a gap, so the
    // parts still add up to the total above them. Same for a cluster that has
    // since been removed from the roster: the work happened, and dropping it
    // would leave a total nothing accounts for.
    const bucket = key || UNASSIGNED;
    if (!byCluster.has(bucket)) {
      byCluster.set(bucket, {
        key: bucket,
        label: bucket === UNASSIGNED ? 'Unassigned' : bucket,
        totals: blankTotals(),
      });
      counts[bucket] = 0;
    }

    counts[bucket] += row.count;
    const entry = byCluster.get(bucket);
    entry.totals.all += row.count;
    if (metric) entry.totals[metric] += row.count;
  }

  return { counts, byCluster: [...byCluster.values()], roster };
}

module.exports = {
  ALL_CLUSTERS,
  UNASSIGNED,
  ACTIVITY_TYPES,
  METRIC_KEYS,
  parseBounds,
  parseClusterKey,
  parseType,
  baseFilter,
  toRow,
  getSummary,
  getActivities,
  getRangeCounts,
  getClusterCounts,
};
