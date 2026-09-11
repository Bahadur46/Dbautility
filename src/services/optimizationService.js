'use strict';

const OptimizationActivity = require('../models/OptimizationActivity');
const { activeCluster } = require('../config/clusterConnections');

/**
 * Writes to the optimisation record that feeds the dashboard.
 *
 * Same rule as the audit service: a dashboard write never breaks the operation
 * it describes. If this collection is unreachable the index was still created,
 * and failing the request over a statistics row would be the wrong trade. The
 * failure goes to stderr so operators can see it.
 */

/** Coerce one measurement payload into the schema's shape. */
function measurement(input) {
  if (!input || typeof input !== 'object') return {};
  const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  return {
    executionTimeMs: num(input.executionTimeMs),
    documentsExamined: num(input.documentsExamined),
    documentsReturned: num(input.documentsReturned),
    keysExamined: num(input.keysExamined),
    planStage: String(input.planStage || '').trim(),
    indexUsed: String(input.indexUsed || '').trim(),
  };
}

/**
 * Persist one optimisation activity.
 *
 * @returns the saved document, or null when the write failed.
 */
async function record({
  activityType,
  databaseName = '',
  collectionName = '',
  subject,
  subjectDetail = null,
  before = null,
  after = null,
  status = 'APPLIED',
  user,
  auditLogId = null,
  manualIndexId = null,
  notes = '',
  clientName = '',
  timestamp = null,
}) {
  try {
    // Read before the write: the model resolves onto the central connection,
    // but the cluster being worked on is the ambient one for this request.
    const cluster = activeCluster();

    return await OptimizationActivity.create({
      activityType,
      cluster: cluster ? cluster.key : '',
      clusterLabel: cluster ? cluster.label : '',
      databaseName: String(databaseName || '').trim(),
      collectionName: String(collectionName || '').trim(),
      subject: String(subject || '').slice(0, 500),
      subjectDetail,
      before: measurement(before),
      after: measurement(after),
      status,
      userId: user.userId,
      userName: user.userName,
      auditLogId: auditLogId || null,
      manualIndexId: manualIndexId || null,
      notes: String(notes || '').slice(0, 1000),
      clientName: String(clientName || '').trim().slice(0, 200),
      timestamp: timestamp ? new Date(timestamp) : new Date(),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[dashboard] Failed to record optimisation activity:', err.message, {
      activityType,
    });
    return null;
  }
}

/**
 * An index was created and really applied to MongoDB.
 *
 * Deliberately not called for DRAFT/INACTIVE definitions: nothing was applied,
 * so nothing was optimised, and counting them would inflate the card above what
 * the database actually gained.
 */
const recordIndexCreated = ({ index, user, auditLog = null, notes = '', databaseName = '' }) =>
  record({
    activityType: 'INDEX_CREATED',
    databaseName: databaseName || index.databaseName || '',
    collectionName: index.collectionName,
    subject: index.appliedIndexName || index.indexName,
    subjectDetail: { indexType: index.indexType, keys: index.keys, options: index.options },
    manualIndexId: index._id || null,
    auditLogId: auditLog ? auditLog._id : null,
    user,
    notes,
  });

/** An index was removed from MongoDB, through any of the drop paths. */
const recordIndexDropped = ({
  databaseName,
  collectionName,
  indexName,
  key = null,
  user,
  auditLog = null,
  manualIndexId = null,
  notes = '',
}) =>
  record({
    activityType: 'INDEX_DROPPED',
    databaseName,
    collectionName,
    subject: indexName,
    subjectDetail: key ? { key } : null,
    manualIndexId,
    auditLogId: auditLog ? auditLog._id : null,
    user,
    notes,
  });

module.exports = { record, recordIndexCreated, recordIndexDropped, measurement };
