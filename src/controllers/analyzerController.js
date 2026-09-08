'use strict';

const analyzerService = require('../services/analyzerService');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { sendSuccess } = require('../utils/apiResponse');

/** Accept a filter/sort that arrives either as an object or as JSON text. */
function parseJsonInput(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('must be a JSON object');
    }
    return parsed;
  } catch (err) {
    throw ApiError.badRequest(`${field} is not valid JSON: ${err.message}`, [
      { field, message: `Not a valid JSON object` },
    ]);
  }
}

/** GET /api/analyzer/profiler — is the profiler available, and is it on? */
const getProfiler = asyncHandler(async (req, res) =>
  sendSuccess(res, { message: 'Profiler status fetched', data: await analyzerService.getProfilerStatus(req.query.database) })
);

/** PUT /api/analyzer/profiler — turn slow-operation recording on or off. */
const setProfiler = asyncHandler(async (req, res) => {
  const { enabled, slowMs } = req.body || {};
  if (typeof enabled !== 'boolean') {
    throw ApiError.badRequest('Validation failed', [{ field: 'enabled', message: 'enabled must be true or false' }]);
  }
  const ms = slowMs === undefined ? 100 : Number(slowMs);
  if (!Number.isFinite(ms) || ms < 0) {
    throw ApiError.badRequest('Validation failed', [{ field: 'slowMs', message: 'slowMs must be 0 or greater' }]);
  }
  const data = await analyzerService.setProfiler({ enabled, slowMs: ms, databaseName: req.body.database });
  return sendSuccess(res, {
    message: enabled ? `Profiler enabled for operations slower than ${ms} ms` : 'Profiler disabled',
    data,
  });
});

/** GET /api/analyzer/slow-queries — recorded slow operations with recommendations. */
const getSlowQueries = asyncHandler(async (req, res) => {
  const minMs = req.query.minMs === undefined ? 100 : Number(req.query.minMs);
  const limit = req.query.limit === undefined ? 200 : Number(req.query.limit);
  if (!Number.isFinite(minMs) || minMs < 0) throw ApiError.badRequest('minMs must be 0 or greater');
  if (!Number.isFinite(limit) || limit < 1 || limit > 1000) throw ApiError.badRequest('limit must be between 1 and 1000');

  return sendSuccess(res, {
    message: 'Slow queries fetched',
    data: await analyzerService.getSlowQueries({ minMs, limit, databaseName: req.query.database }),
  });
});

/**
 * POST /api/analyzer/analyze — analyse one query on demand.
 * Works on every deployment, including Atlas shared tiers.
 */
const analyzeQuery = asyncHandler(async (req, res) => {
  const { collectionName } = req.body || {};
  if (!collectionName || !String(collectionName).trim()) {
    throw ApiError.badRequest('Validation failed', [
      { field: 'collectionName', message: 'Collection name is required' },
    ]);
  }
  const filter = parseJsonInput(req.body.filter, 'filter') || {};
  const sort = parseJsonInput(req.body.sort, 'sort');

  return sendSuccess(res, {
    message: 'Query analysed',
    data: await analyzerService.analyzeQuery({
      collectionName: String(collectionName).trim(),
      databaseName: req.body.databaseName || req.body.database,
      filter,
      sort,
    }),
  });
});

/** GET /api/analyzer/index-usage — which existing indexes are never used. */
const getIndexUsage = asyncHandler(async (req, res) =>
  sendSuccess(res, { message: 'Index usage fetched', data: await analyzerService.getIndexUsage(req.query.database) })
);

/** GET /api/analyzer/overview — collection sizes and index coverage. */
const getOverview = asyncHandler(async (req, res) =>
  sendSuccess(res, { message: 'Overview fetched', data: await analyzerService.getOverview(req.query.database) })
);

/**
 * DELETE /api/analyzer/indexes
 * Drop an index the analyzer reported as unused. Administrator only: unlike
 * the Manual Index flow, this removes an index the application never created,
 * and something else may still depend on it.
 */
const dropIndex = asyncHandler(async (req, res) => {
  if (!req.user.isAdmin) {
    throw ApiError.forbidden(
      'Only an administrator may drop an index directly. Switch to an admin user to do this.'
    );
  }

  const { databaseName, collectionName, indexName, confirm } = req.body || {};
  const errors = [];
  if (!collectionName || !String(collectionName).trim()) {
    errors.push({ field: 'collectionName', message: 'Collection name is required' });
  }
  if (!indexName || !String(indexName).trim()) {
    errors.push({ field: 'indexName', message: 'Index name is required' });
  }
  if (confirm !== true) {
    errors.push({ field: 'confirm', message: 'Confirmation is required before an index is dropped' });
  }
  if (errors.length) throw ApiError.badRequest('Validation failed', errors);

  const result = await analyzerService.dropUnusedIndex({
    databaseName: databaseName || undefined,
    collectionName: String(collectionName).trim(),
    indexName: String(indexName).trim(),
    user: req.user,
    req,
  });

  return sendSuccess(res, {
    message: `Index "${result.name}" was dropped from ${result.databaseName}.${result.collectionName}`,
    data: result,
  });
});

/**
 * POST /api/analyzer/execute
 * Run a pasted mongo shell command. Only a dropIndex is accepted — the text is
 * parsed into arguments, never evaluated — and it goes through the same drop
 * path as the button, so it is audited identically and cannot skip a check.
 */
const executeCommand = asyncHandler(async (req, res) => {
  if (!req.user.isAdmin) {
    throw ApiError.forbidden(
      'Only an administrator may run a command here. Switch to an admin user to do this.'
    );
  }

  const parsed = analyzerService.parseDropCommand((req.body || {}).command);

  const result = await analyzerService.dropUnusedIndex({
    ...parsed,
    user: req.user,
    req,
  });

  return sendSuccess(res, {
    message: `Index "${result.name}" was dropped from ${result.databaseName}.${result.collectionName}`,
    data: result,
  });
});

module.exports = {
  executeCommand,
  getProfiler,
  setProfiler,
  getSlowQueries,
  analyzeQuery,
  getIndexUsage,
  getOverview,
  dropIndex,
};
