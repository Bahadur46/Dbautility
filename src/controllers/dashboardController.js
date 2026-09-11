'use strict';

const dashboardService = require('../services/dashboardService');
const optimizationService = require('../services/optimizationService');
const OptimizationActivity = require('../models/OptimizationActivity');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { sendSuccess } = require('../utils/apiResponse');

/**
 * The DBA Optimization Dashboard, served under /api/dashboard/dba.
 *
 * Every read takes the same scope parameters, so changing the date filter or
 * the cluster in the UI is one parameter change applied uniformly rather than a
 * different contract per panel:
 *
 *   from, to    ISO instants. Either may be absent — "all time" has neither.
 *               Sent as instants rather than a preset name because the browser
 *               resolved them in the reader's timezone; a server recomputing
 *               "this week" from the word could disagree by a day.
 *   cluster     A cluster key, or absent/'all' for every cluster — which is the
 *               view the dashboard opens on.
 */
function scopeOf(req) {
  const { start, end } = dashboardService.parseBounds(req.query.from, req.query.to);
  return {
    clusterKey: dashboardService.parseClusterKey(req.query.cluster),
    start,
    end,
  };
}

/**
 * GET /api/dashboard/dba/summary
 * The KPI card totals, the same totals for the preceding period, and the
 * performance panel.
 */
const getSummary = asyncHandler(async (req, res) => {
  const scope = scopeOf(req);
  const previous = dashboardService.parseBounds(req.query.previousFrom, req.query.previousTo);

  const data = await dashboardService.getSummary({
    ...scope,
    previousStart: previous.start,
    previousEnd: previous.end,
  });

  return sendSuccess(res, { message: 'Optimisation summary fetched successfully', data });
});

/**
 * GET /api/dashboard/dba/activities
 * The recent-activity table, and the drill-down a KPI card opens via
 * `?activityType=`. Filtering happens here rather than in the browser so the
 * total and the page count describe the filtered set — a client-side filter
 * over one page would leave both wrong.
 */
const getActivities = asyncHandler(async (req, res) => {
  const { data, meta } = await dashboardService.getActivities({
    ...scopeOf(req),
    activityType: req.query.activityType,
    databaseName: req.query.database,
    collectionName: req.query.collection,
    status: req.query.status,
    indexType: req.query.indexType,
    search: req.query.search,
    page: req.query.page,
    limit: req.query.limit,
  });

  return sendSuccess(res, {
    message: `${meta.total} ${meta.total === 1 ? 'activity' : 'activities'} found`,
    data,
    meta,
  });
});

/**
 * GET /api/dashboard/dba/range-counts?ranges=[{"key","from","to"}]
 * The count behind each date card, in one request.
 */
const getRangeCounts = asyncHandler(async (req, res) => {
  let ranges;
  try {
    ranges = JSON.parse(req.query.ranges || '[]');
  } catch {
    throw ApiError.badRequest('ranges must be a JSON array of { key, from, to }');
  }

  const data = await dashboardService.getRangeCounts(ranges, {
    clusterKey: dashboardService.parseClusterKey(req.query.cluster),
  });

  return sendSuccess(res, { message: 'Range counts fetched successfully', data });
});

/**
 * GET /api/dashboard/dba/cluster-counts
 * How much of the current date range sits on each cluster — the numbers on the
 * cluster chips. Unscoped by cluster on purpose; see the service.
 */
const getClusterCounts = asyncHandler(async (req, res) => {
  const { start, end } = dashboardService.parseBounds(req.query.from, req.query.to);
  const data = await dashboardService.getClusterCounts({ start, end });
  return sendSuccess(res, { message: 'Cluster counts fetched successfully', data });
});

/**
 * POST /api/dashboard/dba/activities
 *
 * Record an optimisation the server cannot observe for itself.
 *
 * Index creates and drops are written automatically from the paths that perform
 * them, and must not be posted here — that would double-count them against
 * their own cards. What this endpoint is for is the other half of the work: a
 * slow query rewritten in application code, or an API endpoint made cheaper.
 * Nothing in the database changes when that happens, so there is no event for
 * the server to catch; the person who did it reports the before and after
 * numbers, and the dashboard can then account for the whole of the optimisation
 * effort rather than only the part that touched an index.
 */
const AUTOMATIC_TYPES = new Set(['INDEX_CREATED', 'INDEX_DROPPED']);

const createActivity = asyncHandler(async (req, res) => {
  const { activityType, subject } = req.body || {};

  const type = String(activityType || '').trim().toUpperCase();
  if (!OptimizationActivity.ACTIVITY_TYPES.includes(type)) {
    throw ApiError.badRequest(
      `activityType must be one of: ${OptimizationActivity.ACTIVITY_TYPES.join(', ')}`
    );
  }
  if (AUTOMATIC_TYPES.has(type)) {
    throw ApiError.badRequest(
      `${type} activities are recorded automatically when the index is created or dropped, ` +
        'and cannot be posted here — doing so would count the same change twice. ' +
        'Use POST /api/manual-indexes, the drop endpoint on a manual index, or ' +
        'the Query Executor instead.'
    );
  }
  if (!subject || !String(subject).trim()) {
    throw ApiError.badRequest('subject is required — the query, route or index that was optimised');
  }

  const status = req.body.status ? String(req.body.status).toUpperCase() : 'APPLIED';
  if (!OptimizationActivity.STATUSES.includes(status)) {
    throw ApiError.badRequest(`status must be one of: ${OptimizationActivity.STATUSES.join(', ')}`);
  }

  const activity = await optimizationService.record({
    activityType: type,
    databaseName: req.body.databaseName,
    collectionName: req.body.collectionName,
    subject: String(subject).trim(),
    subjectDetail: req.body.subjectDetail || null,
    before: req.body.before,
    after: req.body.after,
    status,
    notes: req.body.notes,
    user: req.user,
  });

  // The recording service swallows its own write errors so it can never break
  // the operation it describes. Here the write IS the operation, so a null
  // result has to be reported rather than answered with 201 and no record.
  if (!activity) {
    throw new ApiError(500, 'The optimisation activity could not be recorded — see the server log');
  }

  return sendSuccess(res, {
    statusCode: 201,
    message: 'Optimisation activity recorded',
    data: dashboardService.toRow(activity),
  });
});

/**
 * GET /api/dashboard/dba/filters/options
 * The values the table's dropdowns should offer, taken from what is actually
 * recorded rather than hard-coded in the client.
 */
const getFilterOptions = asyncHandler(async (req, res) => {
  // Unscoped by cluster: the dropdowns describe everything the dashboard can be
  // pointed at, so narrowing to one cluster cannot empty the very filters used
  // to get back out of it.
  const filter = dashboardService.baseFilter({});

  const [databases, collections, statuses] = await Promise.all([
    OptimizationActivity.distinct('databaseName', filter),
    OptimizationActivity.distinct('collectionName', filter),
    OptimizationActivity.distinct('status', filter),
  ]);

  return sendSuccess(res, {
    message: 'Filter options fetched successfully',
    data: {
      activityTypes: dashboardService.ACTIVITY_TYPES,
      databases: databases.filter(Boolean).sort(),
      collections: collections.filter(Boolean).sort(),
      statuses: statuses.filter(Boolean).sort(),
    },
  });
});

module.exports = {
  getSummary,
  getActivities,
  getRangeCounts,
  getClusterCounts,
  createActivity,
  getFilterOptions,
};
