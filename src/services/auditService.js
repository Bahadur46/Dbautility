'use strict';

const AuditLog = require('../models/AuditLog');
const { config } = require('../config/env');
const { activeCluster } = require('../config/clusterConnections');

/**
 * Audit logging is a backend-only concern. There is deliberately no public
 * write endpoint: every entry originates here, from inside a controller that
 * has just performed (or is performing) the action being recorded.
 */

/** Extract request metadata worth keeping alongside the audit entry. */
function requestMetadata(req) {
  if (!req) return {};
  return {
    ipAddress: req.ip || req.headers['x-forwarded-for'] || '',
    userAgent: req.get ? req.get('user-agent') || '' : '',
    method: req.method || '',
    endpoint: req.originalUrl || '',
  };
}

/** Shallow diff between two snapshots; returns the list of changed field names. */
function diffFields(previous = {}, next = {}) {
  const keys = new Set([...Object.keys(previous || {}), ...Object.keys(next || {})]);
  const changed = [];
  for (const key of keys) {
    const a = previous ? previous[key] : undefined;
    const b = next ? next[key] : undefined;
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) changed.push(key);
  }
  return changed;
}

/**
 * Persist one audit entry.
 *
 * Audit writes never break the primary operation: if the log write fails the
 * error is reported to stderr rather than thrown, so a successful CRUD action
 * is not rolled back by a logging problem. The failure is still visible in the
 * server logs for operators to investigate.
 */
async function record({
  action,
  index,
  user,
  previousValues = null,
  newValues = null,
  details = '',
  mongoCommand = '',
  req = null,
}) {
  try {
    const changedFields =
      action === 'UPDATE' ? diffFields(previousValues, newValues) : [];

    // Read before the write: the model resolves to the central connection, but
    // the cluster the request is working on is still the ambient one.
    const cluster = activeCluster();

    const entry = await AuditLog.create({
      action,
      cluster: cluster ? cluster.key : '',
      clusterLabel: cluster ? cluster.label : '',
      indexId: index._id,
      indexName: index.indexName,
      userId: user.userId,
      userName: user.userName,
      previousValues,
      newValues,
      changedFields,
      details: String(details || '').slice(0, 500),
      mongoCommand: String(mongoCommand || '').slice(0, 1000),
      metadata: requestMetadata(req),
      timestamp: new Date(),
    });

    return entry;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[audit] Failed to write audit log:', err.message, { action });
    return null;
  }
}

const logCreate = ({ index, user, req, details, mongoCommand = '' }) =>
  record({
    action: 'CREATE',
    index,
    user,
    mongoCommand,
    newValues: index.toAuditSnapshot ? index.toAuditSnapshot() : null,
    details: details || `Manual Index "${index.indexName}" was created`,
    req,
  });

const logView = ({ index, user, req }) => {
  // Opening a details page is the noisiest event in the system; some
  // deployments would rather not keep it at all.
  if (!config.logViewActions) return Promise.resolve(null);
  return record({
    action: 'VIEW',
    index,
    user,
    details: `Manual Index "${index.indexName}" details were viewed`,
    req,
  });
};

const logUpdate = ({ index, user, previousValues, newValues, req, detailsSuffix = '', mongoCommand = '' }) => {
  const changed = diffFields(previousValues, newValues);
  const base = changed.length
    ? `Manual Index "${index.indexName}" was updated (${changed.join(', ')})`
    : `Manual Index "${index.indexName}" was saved with no field changes`;
  return record({
    action: 'UPDATE',
    index,
    user,
    mongoCommand,
    previousValues,
    newValues,
    details: `${base}${detailsSuffix}`.slice(0, 500),
    req,
  });
};

const logDelete = ({ index, user, req, details, mongoCommand = '' }) =>
  record({
    action: 'DELETE',
    index,
    user,
    mongoCommand,
    previousValues: index.toAuditSnapshot ? index.toAuditSnapshot() : null,
    details: details || `Manual Index "${index.indexName}" was deleted`,
    req,
  });

/**
 * Record an index dropped straight from the database with no Manual Index
 * record behind it — a command run from the Query Executor. Written before the
 * caller returns, so a drop can never happen without a trace.
 */
const logIndexDrop = ({
  databaseName,
  collectionName,
  indexName,
  key,
  user,
  req,
  mongoCommand = '',
  // Where the drop came from matters when reading the trail back, so callers
  // say so. The default describes a drop of an index nothing here manages.
  details = '',
}) =>
  record({
    action: 'DROP',
    index: { _id: null, indexName },
    user,
    mongoCommand,
    previousValues: { databaseName, collectionName, indexName, key },
    details:
      details ||
      `Index "${indexName}" was dropped from ${databaseName}.${collectionName} by ${user.userName}`,
    req,
  });

/**
 * Retention purge — the ONLY deletion path for audit entries.
 *
 * Deliberately narrow: it removes entries older than a cut-off date and
 * nothing else. There is no way to delete one chosen entry, because being able
 * to remove a single inconvenient record is exactly what an audit log has to
 * prevent. PURGE entries are never removed, so the history of what was purged
 * always survives.
 *
 * The raw collection is used so the model's append-only guards stay in force
 * for every other caller in the codebase.
 */
async function purgeOlderThan({ before, user, req, dryRun = false }) {
  const cutoff = new Date(before);
  if (Number.isNaN(cutoff.getTime())) throw new Error('Invalid cut-off date');

  const filter = { timestamp: { $lt: cutoff }, action: { $ne: 'PURGE' } };
  // Scoped to the caller's cluster. This collection is shared by every
  // cluster, so an unscoped deleteMany here erased the OTHER clusters'
  // audit history too — the one thing an audit log must never allow.
  const purgeCluster = activeCluster();
  if (purgeCluster) filter.cluster = purgeCluster.key;
  const matched = await AuditLog.countDocuments(filter);

  if (dryRun) return { matched, deleted: 0, cutoff, dryRun: true };
  if (matched === 0) return { matched: 0, deleted: 0, cutoff, dryRun: false };

  const result = await AuditLog.collection.deleteMany(filter);
  const deleted = result.deletedCount || 0;

  // The purge is itself an audit event, written after the fact so it survives.
  await record({
    action: 'PURGE',
    index: { _id: null, indexName: 'AUDIT LOG RETENTION' },
    user,
    previousValues: { entriesBefore: matched + (await AuditLog.countDocuments()) - 1 },
    newValues: { cutoff: cutoff.toISOString(), deleted },
    details: `${deleted} audit ${deleted === 1 ? 'entry' : 'entries'} older than ${cutoff.toISOString().slice(0, 10)} were purged by ${user.userName}`,
    req,
  });

  return { matched, deleted, cutoff, dryRun: false };
}

/**
 * Remove every VIEW entry.
 *
 * Deliberately hard-limited to VIEW: it is the one action that records no
 * change, and deployments that treat it as noise rather than audit evidence
 * need a way to clear what was already collected. CREATE, UPDATE, DELETE,
 * DROP and PURGE can never be removed this way — only aged out by
 * `purgeOlderThan` — so nothing that altered anything can be erased by class.
 */
async function purgeViewEntries({ user, req, dryRun = false }) {
  const filter = { action: 'VIEW' };
  // Same reason as purgeOlderThan: never reach past the caller's cluster.
  const viewCluster = activeCluster();
  if (viewCluster) filter.cluster = viewCluster.key;
  const matched = await AuditLog.countDocuments(filter);

  if (dryRun) return { matched, deleted: 0, dryRun: true };
  if (matched === 0) return { matched: 0, deleted: 0, dryRun: false };

  const result = await AuditLog.collection.deleteMany(filter);
  const deleted = result.deletedCount || 0;

  await record({
    action: 'PURGE',
    index: { _id: null, indexName: 'AUDIT LOG RETENTION' },
    user,
    newValues: { removedAction: 'VIEW', deleted },
    details: `${deleted} VIEW ${deleted === 1 ? 'entry was' : 'entries were'} removed by ${user.userName} (view events are not retained)`,
    req,
  });

  return { matched, deleted, dryRun: false };
}

module.exports = {
  record,
  purgeOlderThan,
  purgeViewEntries,
  logIndexDrop,
  logCreate,
  logView,
  logUpdate,
  logDelete,
  diffFields,
};
