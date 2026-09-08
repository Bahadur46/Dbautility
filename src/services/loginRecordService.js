'use strict';

const LoginRecord = require('../models/LoginRecord');
const { containsInsensitive } = require('../utils/query');
const { runOnAuthDb } = require('../config/clusterConnections');

/**
 * The sign-in history.
 *
 * Every attempt — accepted or refused — is written here by the auth service,
 * into the accounts database of the cluster it was made against, beside the
 * LoginTB it was checked against. An attempt naming no valid cluster is
 * refused before it reaches this point, so there is always somewhere to put a
 * row. Rows still carry their cluster and the listing is still narrowed to the
 * caller's own, which keeps the history right for a single-database
 * deployment too.
 */

/** Request metadata worth keeping next to the attempt. */
function requestMetadata(req) {
  if (!req) return { ipAddress: '', userAgent: '' };
  return {
    ipAddress: req.ip || req.headers?.['x-forwarded-for'] || '',
    userAgent: (req.get ? req.get('user-agent') : '') || '',
  };
}

/**
 * Write one attempt.
 *
 * A failure here is logged and swallowed: recording history must never turn a
 * valid sign-in into an error, nor a refused one into a different message.
 */
async function record({
  username,
  user = null,
  cluster = null,
  success,
  outcome,
  reason = '',
  sessionId = '',
  expiresAt = null,
  req = null,
}) {
  try {
    const meta = requestMetadata(req);
    return await runOnAuthDb(() => LoginRecord.create({
      username: String(username || '').trim().toLowerCase(),
      userId: user ? user.userId : null,
      userName: user ? user.displayName || user.userName || '' : '',
      role: user ? user.role || '' : '',
      cluster: cluster ? cluster.key : '',
      clusterLabel: cluster ? cluster.label : '',
      success,
      outcome,
      reason: String(reason || '').slice(0, 200),
      sessionId,
      expiresAt,
      ipAddress: meta.ipAddress,
      userAgent: String(meta.userAgent || '').slice(0, 400),
      timestamp: new Date(),
    }), cluster);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[login-record] Failed to write login record:', err.message);
    return null;
  }
}

/** Close the open record for a session, so the row shows when it ended. */
async function recordLogout(sessionId, cluster = null) {
  if (!sessionId) return null;
  try {
    return await runOnAuthDb(() =>
      LoginRecord.findOneAndUpdate(
        { sessionId, success: true, loggedOutAt: null },
        { $set: { loggedOutAt: new Date() } },
        { new: true }
      ),
    cluster);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[login-record] Failed to close login record:', err.message);
    return null;
  }
}

/**
 * The filter behind the listing, built from the query string.
 *
 * `cluster` is not taken from the query: it is the cluster of the session
 * asking, so no parameter can widen a listing beyond it.
 */
function buildFilter(query = {}, cluster = null) {
  const { search, username, userId, outcome, status, startDate, endDate } = query;
  // LoginTB also holds the accounts themselves; only attempt rows carry an
  // outcome, so every read of the history starts by excluding the rest.
  const filter = { outcome: { $exists: true } };

  if (cluster) filter.cluster = cluster.key;

  if (username) filter.username = String(username).trim().toLowerCase();
  if (userId) filter.userId = userId;

  if (outcome) {
    const wanted = String(outcome)
      .split(',')
      .map((o) => o.trim().toUpperCase())
      .filter((o) => LoginRecord.OUTCOMES.includes(o));
    if (wanted.length) filter.outcome = { $in: wanted };
  }

  // `status` is the plain-language version of the same thing, which is what
  // the page's dropdown sends.
  const normalizedStatus = String(status || '').toLowerCase();
  if (normalizedStatus === 'success') filter.success = true;
  else if (normalizedStatus === 'failed') filter.success = false;

  if (startDate || endDate) {
    filter.timestamp = {};
    if (startDate) {
      const from = new Date(startDate);
      if (!Number.isNaN(from.getTime())) filter.timestamp.$gte = from;
    }
    if (endDate) {
      const to = new Date(endDate);
      if (!Number.isNaN(to.getTime())) {
        // A plain date means the whole of that day, not its first instant.
        if (!/T/.test(String(endDate))) to.setHours(23, 59, 59, 999);
        filter.timestamp.$lte = to;
      }
    }
    if (!Object.keys(filter.timestamp).length) delete filter.timestamp;
  }

  if (search && String(search).trim()) {
    const rx = containsInsensitive(String(search).trim());
    filter.$or = [{ username: rx }, { userName: rx }, { userId: rx }, { ipAddress: rx }];
  }

  return filter;
}

/** One page of the history, newest first, for one cluster. */
async function list(query = {}, cluster = null) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
  const allowedSort = ['timestamp', 'username', 'outcome'];
  const sortBy = allowedSort.includes(query.sortBy) ? query.sortBy : 'timestamp';
  const sortOrder = query.sortOrder === 'asc' ? 1 : -1;

  const filter = buildFilter(query, cluster);

  return runOnAuthDb(async () => {
    const [items, total] = await Promise.all([
      LoginRecord.find(filter)
        .sort({ [sortBy]: sortOrder })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      LoginRecord.countDocuments(filter),
    ]);

    return { items, total, page, limit };
  }, cluster);
}

/** Headline counts for the page, over the same filter as the listing. */
async function stats(query = {}, cluster = null) {
  const filter = buildFilter(query, cluster);
  return runOnAuthDb(async () => {
    const [total, successful, users] = await Promise.all([
      LoginRecord.countDocuments(filter),
      LoginRecord.countDocuments({ ...filter, success: true }),
      LoginRecord.distinct('username', filter),
    ]);
    return { total, successful, failed: total - successful, users: users.length };
  }, cluster);
}

module.exports = { record, recordLogout, list, stats, buildFilter };
