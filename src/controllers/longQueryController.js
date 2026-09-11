'use strict';

const longQueryService = require('../services/longQueryService');
const optimizationService = require('../services/optimizationService');
const dashboardService = require('../services/dashboardService');
const OptimizationActivity = require('../models/OptimizationActivity');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { sendSuccess } = require('../utils/apiResponse');

/**
 * Long queries: diagnose one, record it, and close it once it is fixed.
 *
 * The three endpoints are one workflow, and the split between them is the point:
 *
 *   analyze   read-only. Paste the operation document, get the diagnosis and
 *             the index it wants. Nothing is written, so it can be run against
 *             anything without leaving a trail of half-finished work.
 *   record    the query is real and worth fixing. It is written PENDING, with
 *             the "before" measurements taken from the operation document
 *             rather than typed, so the baseline is the server's own numbers.
 *   resolve   it has been fixed. The "after" measurements complete the record,
 *             the improvement is computed from the two, and the dashboard's
 *             Long Queries card and performance panel account for it.
 *
 * PENDING is deliberate: a long query that has been found but not yet fixed is
 * still worth having on the board. It is counted on the card — the work exists
 * — but the performance panel averages only APPLIED rows, so an unfinished one
 * can never flatter the improvement figure.
 */

// The two categories a person reports and later resolves. Index work is
// recorded automatically at the moment it happens and is complete on arrival.
const RESOLVABLE = new Set(['LONG_QUERY', 'API_OPTIMIZATION']);

/**
 * POST /api/dashboard/dba/long-queries/analyze
 *
 * Body: the operation document itself, or `{ op: <document> }`. A
 * `db.currentOp()` entry, a `system.profile` row and a slow-query log line all
 * work — they describe the same thing in slightly different words.
 */
const analyzeLongQuery = asyncHandler(async (req, res) => {
  const op = req.body && req.body.op ? req.body.op : req.body;
  const data = longQueryService.analyze(op);

  return sendSuccess(res, {
    message: data.findings.length
      ? `${data.findings.length} ${data.findings.length === 1 ? 'finding' : 'findings'} on ${data.namespace}`
      : `No obvious problem found on ${data.namespace}`,
    data,
  });
});

/**
 * POST /api/dashboard/dba/long-queries
 *
 * Record a long query as work to be done. Body: `{ op, notes?, status? }`.
 */
const recordLongQuery = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const op = body.op || body;
  const analysis = longQueryService.analyze(op);

  const type = String(body.activityType || 'LONG_QUERY').toUpperCase();
  if (!RESOLVABLE.has(type)) {
    throw ApiError.badRequest(`activityType must be one of: ${[...RESOLVABLE].join(', ')}`);
  }

  // PENDING unless the caller says the fix is already in place.
  const status = String(body.status || 'PENDING').toUpperCase();
  if (!OptimizationActivity.STATUSES.includes(status)) {
    throw ApiError.badRequest(`status must be one of: ${OptimizationActivity.STATUSES.join(', ')}`);
  }

  const activity = await optimizationService.record({
    activityType: type,
    databaseName: analysis.databaseName,
    collectionName: analysis.collectionName,
    subject: body.subject || analysis.subject,
    // The recommendation and the plan travel with the record, so whoever picks
    // it up later does not have to re-derive what was already worked out.
    subjectDetail: {
      queryHash: analysis.queryHash,
      match: longQueryService.parseOp(op).match,
      plan: analysis.plan,
      recommendedIndex: analysis.recommendedIndex,
      findings: analysis.findings,
    },
    before: analysis.before,
    status,
    notes: body.notes || '',
    user: req.user,
  });

  if (!activity) {
    throw new ApiError(500, 'The long query could not be recorded — see the server log');
  }

  return sendSuccess(res, {
    statusCode: 201,
    message:
      status === 'PENDING'
        ? 'Long query recorded. Resolve it once the fix is in place to record the improvement.'
        : 'Long query recorded',
    data: { activity: dashboardService.toRow(activity), analysis },
  });
});

/**
 * POST /api/dashboard/dba/api-optimizations
 *
 * Record an API endpoint that was, or is about to be, made cheaper.
 *
 * There is no operation document to parse here, and that is the whole
 * difference from a long query. A slow query is something MongoDB observed and
 * described; an API call is measured from outside the database — the route, and
 * what a request costs. So the measurements are given rather than parsed, and
 * the route is the subject.
 *
 * It closes through the same resolve endpoint, because "what does it cost now"
 * is the same question whichever kind of work was done.
 */
/**
 * A pasted endpoint, split into the parts worth keeping apart.
 *
 * A whole URL is what anyone actually has to hand — copied from a browser, a
 * log, or the network tab — so it is accepted as typed. But the *identity* of
 * the endpoint is its path: `?tabErpID=3435` is one request, not a different
 * API, and keeping the query string in the subject would file every call to the
 * same endpoint as its own separate piece of work, so the dashboard could never
 * say "this endpoint was optimised".
 *
 * The full URL is kept alongside, because the parameters are exactly what
 * someone reproducing the slow call needs.
 */
function splitEndpoint(input) {
  const raw = String(input || '').trim();
  if (!/^https?:\/\//i.test(raw)) {
    // Already a path. Anything after "?" is still a sample, not an identity.
    const [path, query] = raw.split('?');
    return {
      route: path || raw,
      url: raw,
      host: '',
      queryParams: query ? Object.fromEntries(new URLSearchParams(query)) : null,
    };
  }

  try {
    // A space in a value — "tabName=Godown Summary" — is not legal in a URL and
    // WHATWG parsing encodes it rather than rejecting it, which is what makes
    // pasting from a browser bar work at all.
    const url = new URL(raw);
    const queryParams = Object.fromEntries(url.searchParams);
    return {
      route: url.pathname,
      url: raw,
      host: url.host,
      queryParams: Object.keys(queryParams).length ? queryParams : null,
    };
  } catch {
    throw ApiError.badRequest(`"${raw}" could not be read as a URL or a path`);
  }
}

const recordApiOptimization = asyncHandler(async (req, res) => {
  const body = req.body || {};

  const given = String(body.route || body.subject || '').trim();
  if (!given) {
    throw ApiError.badRequest('route is required — the endpoint that was optimised');
  }
  const endpoint = splitEndpoint(given);
  const route = endpoint.route;
  const method = String(body.method || '').trim().toUpperCase();

  const status = String(body.status || 'IN_PROGRESS').toUpperCase();
  if (!OptimizationActivity.STATUSES.includes(status)) {
    throw ApiError.badRequest(`status must be one of: ${OptimizationActivity.STATUSES.join(', ')}`);
  }

  // A baseline is welcome but not demanded. The board's first job is to say
  // which endpoints are being worked on and for whom; insisting on a timing
  // before an entry can exist would keep the work off the board until someone
  // had measured it, which is exactly backwards. Without one the row simply
  // carries no improvement — a blank, never a zero.
  const before = optimizationService.measurement(body.before);

  // An "after" at record time is allowed: work already finished when someone
  // gets round to logging it should not have to be filed twice.
  const after = body.after ? optimizationService.measurement(body.after) : null;

  const activity = await optimizationService.record({
    activityType: 'API_OPTIMIZATION',
    databaseName: body.databaseName,
    collectionName: body.collectionName,
    clientName: body.clientName,
    // The method belongs in front of the path, the way anyone would say it.
    subject: method ? `${method} ${route}` : route,
    subjectDetail: {
      route,
      method: method || null,
      // The call as it was actually given, with its parameters. The subject
      // above identifies the endpoint; this is what reproduces the slow request.
      url: endpoint.url !== route ? endpoint.url : null,
      host: endpoint.host || null,
      queryParams: endpoint.queryParams,
      // What the endpoint was doing that cost the time, when it is known.
      dependsOn: body.dependsOn || null,
    },
    before,
    after,
    // A row with an "after" is live by definition; without one it stays wherever
    // the board put it.
    status: after && after.executionTimeMs !== null ? 'APPLIED' : status,
    notes: body.notes || '',
    user: req.user,
  });

  if (!activity) {
    throw new ApiError(500, 'The API optimisation could not be recorded — see the server log');
  }

  const row = dashboardService.toRow(activity);
  return sendSuccess(res, {
    statusCode: 201,
    message:
      row.improvementPct === null
        ? 'API optimisation recorded. Resolve it once the change is live to record the improvement.'
        : `API optimisation recorded — ${row.beforeMs} ms to ${row.afterMs} ms, ${row.improvementPct}% faster.`,
    data: row,
  });
});

/**
 * POST /api/dashboard/dba/long-queries/:id/resolve
 *
 * Close a recorded query with what it costs now. Body is either `{ op }` — the
 * same operation document taken again after the fix — or `{ after: {...} }`
 * with the measurements directly.
 */
const resolveLongQuery = asyncHandler(async (req, res) => {
  const body = req.body || {};

  const activity = await OptimizationActivity.findById(req.params.id);
  if (!activity) throw ApiError.notFound('That optimisation activity does not exist');

  if (!RESOLVABLE.has(activity.activityType)) {
    throw ApiError.badRequest(
      `A ${activity.activityType} activity is recorded complete at the moment it happens, ` +
        'so there is nothing to resolve.'
    );
  }

  // Either shape is accepted, but one of them has to be there: resolving with
  // no measurement would mark the work done while leaving the dashboard unable
  // to say what it bought.
  let after = null;
  if (body.op) {
    after = longQueryService.toMeasurement(longQueryService.parseOp(body.op));
  } else if (body.after && typeof body.after === 'object') {
    after = optimizationService.measurement(body.after);
  } else {
    throw ApiError.badRequest(
      'Send either { op: <the operation document after the fix> } or { after: { executionTimeMs, … } }'
    );
  }

  if (after.executionTimeMs === null) {
    throw ApiError.badRequest(
      'The "after" measurement has no execution time, so no improvement could be computed'
    );
  }

  activity.after = after;
  activity.status = String(body.status || 'APPLIED').toUpperCase();
  if (!OptimizationActivity.STATUSES.includes(activity.status)) {
    throw ApiError.badRequest(`status must be one of: ${OptimizationActivity.STATUSES.join(', ')}`);
  }
  if (body.notes) activity.notes = String(body.notes).slice(0, 1000);
  // `improvementPercent` is recomputed by the model's own pre-validate hook, so
  // it is never accepted from the caller and cannot disagree with the two
  // measurements printed beside it.
  await activity.save();

  const row = dashboardService.toRow(activity);
  return sendSuccess(res, {
    message:
      row.improvementPct === null
        ? 'Resolved.'
        : `Resolved — ${row.beforeMs} ms to ${row.afterMs} ms, ${row.improvementPct}% faster.`,
    data: row,
  });
});

/**
 * POST /api/dashboard/dba/optimizations/:id/status
 *
 * Move a row along the board — In progress, To be tested, Done.
 *
 * Separate from resolve because the two say different things. Resolve reports
 * what the work bought and needs a measurement; this reports where it has got
 * to and needs none. Marking something Done with no "after" is allowed: plenty
 * of work is finished without anyone timing it, and refusing to let the board
 * say so would only push people to invent a number.
 */
const setStatus = asyncHandler(async (req, res) => {
  const next = String((req.body || {}).status || '').toUpperCase();
  if (!OptimizationActivity.STATUSES.includes(next)) {
    throw ApiError.badRequest(`status must be one of: ${OptimizationActivity.STATUSES.join(', ')}`);
  }

  const activity = await OptimizationActivity.findById(req.params.id);
  if (!activity) throw ApiError.notFound('That optimisation activity does not exist');

  activity.status = next;
  if (req.body.clientName !== undefined) {
    activity.clientName = String(req.body.clientName).trim().slice(0, 200);
  }
  if (req.body.notes !== undefined) activity.notes = String(req.body.notes).slice(0, 1000);
  await activity.save();

  return sendSuccess(res, {
    message: `Moved to ${next.toLowerCase().replace(/_/g, ' ')}`,
    data: dashboardService.toRow(activity),
  });
});

/**
 * DELETE /api/dashboard/dba/optimizations/:id
 *
 * Remove a row from the board.
 *
 * Only the hand-entered kinds can go. A long query and an API optimisation are
 * typed by a person, so a mistyped URL or a duplicate is a mistake to correct,
 * and refusing to let it be corrected only leaves the board wrong.
 *
 * Index creates and drops are refused. Those are not entries anyone made — the
 * server wrote them at the moment an index really changed, and they are the
 * dashboard's record that the change happened. Deleting one would quietly
 * remove the evidence of work the database actually did, leaving a total that
 * nothing accounts for. The audit trail keeps its own copy either way, which is
 * what makes this a loss of the summary rather than of the fact.
 */
const DELETABLE = new Set(['LONG_QUERY', 'API_OPTIMIZATION']);

const deleteOptimization = asyncHandler(async (req, res) => {
  const activity = await OptimizationActivity.findById(req.params.id);
  if (!activity) throw ApiError.notFound('That optimisation activity does not exist');

  if (!DELETABLE.has(activity.activityType)) {
    throw ApiError.badRequest(
      `A ${activity.activityType} row was written by the server when the index actually changed, ` +
        'so it is a record of something that happened rather than an entry to correct. It cannot be deleted here.'
    );
  }

  const removed = dashboardService.toRow(activity);
  await OptimizationActivity.deleteOne({ _id: activity._id });

  return sendSuccess(res, {
    message: `Removed "${removed.target}" from the board`,
    data: { _id: removed._id, target: removed.target },
  });
});

module.exports = {
  deleteOptimization,
  setStatus,
  analyzeLongQuery,
  recordLongQuery,
  recordApiOptimization,
  resolveLongQuery,
};
