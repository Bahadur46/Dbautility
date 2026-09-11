'use strict';

const AuditLog = require('../models/AuditLog');
const auditService = require('../services/auditService');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { sendSuccess, buildPagination } = require('../utils/apiResponse');
const { containsInsensitive } = require('../utils/query');
const { config } = require('../config/env');

/**
 * GET /api/audit-logs
 * Read-only listing with search, action/user/date filters, sorting and
 * pagination. There is no create/update/delete counterpart by design.
 */
/** Build the query filter shared by the list and the export. */
function buildFilter(query, cluster) {
  const { search, action, excludeAction, userId, indexId, startDate, endDate } = query;
  const filter = {};

  // The audit trail is one central collection shared by every cluster, and
  // each entry records the cluster it happened on. Without this line a
  // session on one cluster read — and exported — every other cluster's
  // change history: index names, collection names, usernames and full
  // before/after values.
  if (cluster && cluster.key) filter.cluster = cluster.key;

  const parseActions = (value) =>
    String(value || '')
      .split(',')
      .map((a) => a.trim().toUpperCase())
      .filter((a) => AuditLog.ACTIONS.includes(a));

  if (action) {
    const actions = parseActions(action);
    // An unrecognised action used to be dropped, which silently returned the
    // WHOLE log to a caller who believed it was filtered. Say so instead.
    if (!actions.length) throw ApiError.badRequest(`Unknown action filter: ${String(action)}`);
    filter.action = { $in: actions };
  }

  // Excluding happens here rather than in the browser: filtering a page of
  // results client-side would leave the totals and page count wrong.
  if (excludeAction) {
    const excluded = parseActions(excludeAction);
    if (!excluded.length) {
      throw ApiError.badRequest(`Unknown excludeAction filter: ${String(excludeAction)}`);
    }
    filter.action = { ...(filter.action || {}), $nin: excluded };
  }
  // String(): Express' extended query parser turns ?userId[$regex]=... into an
  // object, which went straight into the Mongo filter as an operator.
  if (userId) filter.userId = String(userId);
  if (indexId) filter.indexId = String(indexId);

  if (startDate || endDate) {
    filter.timestamp = {};
    if (startDate) {
      const from = new Date(startDate);
      if (Number.isNaN(from.getTime())) throw ApiError.badRequest('Invalid startDate');
      filter.timestamp.$gte = from;
    }
    if (endDate) {
      const to = new Date(endDate);
      if (Number.isNaN(to.getTime())) throw ApiError.badRequest('Invalid endDate');
      if (!/T/.test(String(endDate))) to.setHours(23, 59, 59, 999);
      filter.timestamp.$lte = to;
    }
  }

  if (search && String(search).trim()) {
    const rx = containsInsensitive(String(search).trim());
    filter.$or = [{ indexName: rx }, { userName: rx }, { userId: rx }, { details: rx }];
  }

  return filter;
}

/** One audit entry as a flat row, for CSV. */
function toCsvRow(log) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    cell(log._id), cell(log.timestamp?.toISOString?.() || log.timestamp), cell(log.action),
    cell(log.indexName), cell(log.indexId), cell(log.userName), cell(log.userId),
    cell(log.details), cell(log.mongoCommand), cell((log.changedFields || []).join('; ')),
    cell(log.previousValues), cell(log.newValues),
    cell(log.metadata?.method), cell(log.metadata?.endpoint), cell(log.metadata?.ipAddress),
  ].join(',');
}

const CSV_HEADER = [
  'id','timestamp','action','indexName','indexId','userName','userId',
  'details','mongoCommand','changedFields','previousValues','newValues','method','endpoint','ipAddress',
].join(',');

/**
 * GET /api/audit-logs/export
 * Download the filtered log as CSV or JSON — the safe way to keep a copy
 * before purging, and useful for reporting on its own.
 */
const exportAuditLogs = asyncHandler(async (req, res) => {
  const format = String(req.query.format || 'csv').toLowerCase();
  if (!['csv', 'json'].includes(format)) {
    throw ApiError.badRequest('format must be csv or json');
  }

  const filter = buildFilter(req.query, req.cluster);
  const stamp = new Date().toISOString().slice(0, 10);

  // Streamed with a cursor rather than loaded into an array: an audit log
  // grows without bound, and holding the whole export in memory would spike
  // the process on exactly the deployments where the log matters most.
  const cursor = AuditLog.find(filter).sort({ timestamp: -1 }).lean().cursor();

  res.setHeader(
    'Content-Type',
    format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8'
  );
  res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${stamp}.${format}"`);

  if (format === 'json') res.write('[\n');
  else res.write(`${CSV_HEADER}\n`);

  let first = true;
  try {
    for await (const log of cursor) {
      if (format === 'json') {
        res.write((first ? '' : ',\n') + JSON.stringify(log));
      } else {
        res.write(`${first ? '' : '\n'}${toCsvRow(log)}`);
      }
      first = false;
    }
  } catch (err) {
    // Headers are already sent, so the failure is reported inside the payload
    // rather than as a status code the client will never see.
    res.write(format === 'json' ? `\n]` : `\n# EXPORT FAILED: ${err.message}`);
    return res.end();
  } finally {
    await cursor.close().catch(() => {});
  }

  if (format === 'json') res.write('\n]');
  return res.end();
});

/** Resolve and validate the retention cut-off shared by preview and purge. */
function resolveCutoff(source) {
  const days = source.olderThanDays;
  if (days === undefined || days === null || days === '') {
    throw ApiError.badRequest('Validation failed', [
      { field: 'olderThanDays', message: 'Say how old an entry must be before it is removed' },
    ]);
  }
  const n = Number(days);
  // 0 is allowed and means "up to right now", so today's entries can be cleared too.
  if (!Number.isFinite(n) || n < 0) {
    throw ApiError.badRequest('Validation failed', [
      { field: 'olderThanDays', message: 'Must be a whole number of days, 0 or more' },
    ]);
  }
  const cutoff = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return { days: Math.floor(n), cutoff };
}

/**
 * GET /api/audit-logs/purge/preview?olderThanDays=90
 * How many entries a purge would remove — shown before anything is deleted.
 */
const previewPurge = asyncHandler(async (req, res) => {
  // VIEW-only mode: no cut-off, every view event.
  if (String(req.query.mode || '').toLowerCase() === 'views') {
    const result = await auditService.purgeViewEntries({ user: req.user, dryRun: true });
    return sendSuccess(res, {
      message:
        result.matched === 0
          ? 'There are no view events to remove.'
          : `${result.matched} view ${result.matched === 1 ? 'entry' : 'entries'} would be removed.`,
      data: { mode: 'views', matched: result.matched, total: await AuditLog.countDocuments() },
    });
  }

  const { days, cutoff } = resolveCutoff(req.query);
  const result = await auditService.purgeOlderThan({ before: cutoff, user: req.user, dryRun: true });

  return sendSuccess(res, {
    message:
      result.matched === 0
        ? 'There is nothing to remove.'
        : days === 0
          ? `${result.matched} ${result.matched === 1 ? 'entry' : 'entries'} would be removed, including today's.`
          : `${result.matched} ${result.matched === 1 ? 'entry is' : 'entries are'} older than ${days} days.`,
    data: { olderThanDays: days, cutoff, matched: result.matched, total: await AuditLog.countDocuments() },
  });
});

/**
 * POST /api/audit-logs/purge
 * Delete entries older than the cut-off. Admin only, and the purge is itself
 * recorded as a PURGE entry that no purge will ever remove.
 */
const purgeAuditLogs = asyncHandler(async (req, res) => {
  if (!req.user.isAdmin) {
    throw ApiError.forbidden(
      'Only an administrator may purge audit logs. Switch to an admin user to do this.'
    );
  }

  if (req.body?.confirm !== true) {
    throw ApiError.badRequest('Validation failed', [
      { field: 'confirm', message: 'Confirmation is required before entries are deleted' },
    ]);
  }

  // VIEW-only mode. No other action can be removed by class.
  if (String(req.body?.mode || '').toLowerCase() === 'views') {
    const viewResult = await auditService.purgeViewEntries({ user: req.user, req });
    return sendSuccess(res, {
      message:
        viewResult.deleted === 0
          ? 'There were no view events to remove.'
          : `${viewResult.deleted} view ${viewResult.deleted === 1 ? 'entry was' : 'entries were'} removed. The removal itself is recorded.`,
      data: { mode: 'views', deleted: viewResult.deleted, remaining: await AuditLog.countDocuments() },
    });
  }

  const { days, cutoff } = resolveCutoff(req.body || {});

  const result = await auditService.purgeOlderThan({ before: cutoff, user: req.user, req });

  return sendSuccess(res, {
    message:
      result.deleted === 0
        ? 'There was nothing to remove — no entries were removed.'
        : days === 0
          ? `${result.deleted} audit ${result.deleted === 1 ? 'entry' : 'entries'}, including today's, were removed. The purge itself is recorded.`
          : `${result.deleted} audit ${result.deleted === 1 ? 'entry' : 'entries'} older than ${days} days were removed. The purge itself is recorded.`,
    data: { olderThanDays: days, cutoff, deleted: result.deleted, remaining: await AuditLog.countDocuments() },
  });
});

const getAuditLogs = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
  const allowedSort = ['timestamp', 'action', 'indexName', 'userName'];
  const sortBy = allowedSort.includes(req.query.sortBy) ? req.query.sortBy : 'timestamp';
  const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;

  const filter = buildFilter(req.query, req.cluster);

  const [items, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ [sortBy]: sortOrder })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    AuditLog.countDocuments(filter),
  ]);

  return sendSuccess(res, {
    message: 'Audit logs fetched successfully',
    data: items,
    meta: buildPagination({ page, limit, total }),
  });
});

/**
 * GET /api/audit-logs/:id
 * Details of a single audit entry.
 */
const getAuditLogById = asyncHandler(async (req, res) => {
  const log = await AuditLog.findById(req.params.id).lean();
  if (!log) throw ApiError.notFound('Audit log not found');

  return sendSuccess(res, { message: 'Audit log fetched successfully', data: log });
});

/**
 * GET /api/audit-logs/filters/options
 * Distinct users and actions present in the log, used to populate the
 * filter dropdowns on the Audit Logs page.
 */
const getFilterOptions = asyncHandler(async (req, res) => {
  const users = await AuditLog.aggregate([
    { $group: { _id: '$userId', userName: { $last: '$userName' }, count: { $sum: 1 } } },
    { $sort: { userName: 1 } },
  ]);

  return sendSuccess(res, {
    message: 'Filter options fetched successfully',
    data: {
      // VIEW is offered as a filter only when it is actually being recorded.
      actions: AuditLog.ACTIONS.filter((a) => a !== 'VIEW' || config.logViewActions),
      viewLoggingEnabled: config.logViewActions,
      users: users.map((u) => ({ userId: u._id, userName: u.userName, count: u.count })),
    },
  });
});

/**
 * Explicit rejection for any attempt to write to the audit log through the API.
 * Mounted on POST/PUT/PATCH/DELETE so clients get a clear 403 instead of a 404.
 */
const rejectMutation = (req, res) =>
  res.status(403).json({
    success: false,
    message:
      'Audit logs are generated automatically by the system and cannot be created, modified or deleted individually. ' +
      'Old entries can be removed in bulk by an administrator through the retention purge.',
  });

module.exports = {
  getAuditLogs,
  getAuditLogById,
  getFilterOptions,
  exportAuditLogs,
  previewPurge,
  purgeAuditLogs,
  rejectMutation,
};
