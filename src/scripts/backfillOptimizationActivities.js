'use strict';

/**
 * Fill the dashboard's optimisation record from the audit trail already on disk.
 *
 * The dashboard reads `optimizationactivities`, which is only written from the
 * moment the recording hooks shipped. Every index created or dropped before
 * that is in `auditlogs` and nowhere else, so a deployment with real history
 * opens on a dashboard of zeros — the work happened, it simply was not counted.
 * This walks the audit trail and writes the activity that each entry describes.
 *
 *   node src/scripts/backfillOptimizationActivities.js --dry-run
 *   node src/scripts/backfillOptimizationActivities.js
 *
 * Safe to run twice: each activity records the `auditLogId` it came from, and
 * an audit entry that already has one is skipped. Nothing in `auditlogs` is
 * modified — it is append-only, and this only reads it.
 *
 * What is NOT backfilled, and why it matters when reading the result:
 *
 *   Execution times and documents examined. The audit trail never recorded
 *   them — it holds field snapshots, not query plans — so backfilled rows carry
 *   no before/after and no improvement percentage. The KPI cards, the cluster
 *   chips and the activity table become correct immediately; the performance
 *   panel stays empty until measured optimisations are recorded. Inventing a
 *   plausible "850ms → 120ms" for these rows was the alternative, and a
 *   fabricated improvement figure is worse than an honest blank.
 *
 *   UPDATE entries. An update that re-applies an index drops and recreates the
 *   same one, so counting it as another INDEX_CREATED would double-count an
 *   index the original CREATE already counted.
 *
 *   CREATE and DELETE entries that never touched the database — a DRAFT
 *   definition, or a delete with no applied index behind it. `mongoCommand` is
 *   empty on those, which is exactly the test for "did this change MongoDB".
 */

const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../config/db');
const { connectAllClusters, disconnectClusters, centralConnection } = require('../config/clusterConnections');
const clusters = require('../config/clusters');

/* eslint-disable no-console */

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * The database and collection a recorded shell command worked on.
 *
 * Read from the command rather than the field snapshot because the snapshot's
 * `databaseName` is blank whenever the index landed on the cluster's default
 * target database — the command always names it in full.
 */
function targetOf(mongoCommand) {
  const match = /getSiblingDB\("([^"]+)"\)\.getCollection\("([^"]+)"\)/.exec(mongoCommand || '');
  return match ? { databaseName: match[1], collectionName: match[2] } : null;
}

/** A measurement subdocument with every field explicitly unmeasured. */
const EMPTY_MEASUREMENT = () => ({
  executionTimeMs: null,
  documentsExamined: null,
  documentsReturned: null,
  keysExamined: null,
  planStage: '',
  indexUsed: '',
});

/** The activity one audit entry describes, or null when it describes none. */
function activityFor(entry) {
  const command = entry.mongoCommand || '';
  // No command means nothing was applied to MongoDB: a DRAFT definition, a
  // VIEW, a PURGE, or a delete with no real index behind it.
  if (!command) return null;

  let activityType;
  if (entry.action === 'CREATE') activityType = 'INDEX_CREATED';
  else if (entry.action === 'DROP' || entry.action === 'DELETE') activityType = 'INDEX_DROPPED';
  else return null; // UPDATE, and anything added later — see the header.

  // A DELETE only dropped an index if its command actually says dropIndex.
  if (activityType === 'INDEX_DROPPED' && !/\.dropIndex\(/.test(command)) return null;
  if (activityType === 'INDEX_CREATED' && !/\.createIndex\(/.test(command)) return null;

  const snapshot = entry.newValues || entry.previousValues || {};
  const target = targetOf(command) || {
    databaseName: snapshot.databaseName || '',
    collectionName: snapshot.collectionName || '',
  };

  return {
    activityType,
    cluster: entry.cluster || '',
    clusterLabel: entry.clusterLabel || '',
    databaseName: target.databaseName,
    collectionName: target.collectionName,
    subject: entry.indexName,
    subjectDetail: snapshot.keys ? { indexType: snapshot.indexType, keys: snapshot.keys } : null,
    // Written out in full rather than as {}: a document that simply lacks a
    // field is not the same as one that records the field as unmeasured. In an
    // aggregation expression a MISSING field is not equal to null, so an absent
    // `improvementPercent` reads as a measured 0% and an absent
    // `after.indexUsed` reads as "served by an index". The readers guard
    // against both with $ifNull, but a row that matches the model's own shape
    // cannot provoke the question in the first place.
    before: EMPTY_MEASUREMENT(),
    after: EMPTY_MEASUREMENT(),
    improvementPercent: null,
    status: 'APPLIED',
    userId: entry.userId,
    userName: entry.userName,
    auditLogId: entry._id,
    manualIndexId: entry.indexId || null,
    notes: 'Backfilled from the audit trail',
    timestamp: entry.timestamp,
  };
}

async function run() {
  await connectDB();
  if (clusters.isEnabled()) await connectAllClusters();

  const connection = centralConnection();
  const auditLogs = connection.db.collection('auditlogs');
  const activities = connection.db.collection('optimizationactivities');

  const total = await auditLogs.countDocuments();
  console.log(`Audit entries on ${connection.db.databaseName}: ${total}`);

  // Which entries have already been accounted for, so a second run is a no-op.
  const already = new Set(
    (await activities.distinct('auditLogId', { auditLogId: { $ne: null } })).map(String)
  );
  if (already.size) console.log(`Already backfilled: ${already.size}`);

  const entries = await auditLogs.find({}).sort({ timestamp: 1 }).toArray();

  const pending = [];
  const skipped = { alreadyDone: 0, noChange: 0 };

  for (const entry of entries) {
    if (already.has(String(entry._id))) {
      skipped.alreadyDone += 1;
      continue;
    }
    const activity = activityFor(entry);
    if (!activity) {
      skipped.noChange += 1;
      continue;
    }
    pending.push(activity);
  }

  const perCluster = {};
  for (const a of pending) {
    const key = a.cluster || '(unassigned)';
    perCluster[key] = perCluster[key] || {};
    perCluster[key][a.activityType] = (perCluster[key][a.activityType] || 0) + 1;
  }

  console.log(`\nTo write: ${pending.length}`);
  for (const [key, counts] of Object.entries(perCluster)) {
    console.log(`  ${key.padEnd(12)} ${JSON.stringify(counts)}`);
  }
  console.log(
    `Skipped: ${skipped.alreadyDone} already backfilled, ` +
      `${skipped.noChange} that changed no index (UPDATE, VIEW, PURGE, or nothing applied)`
  );

  if (!pending.length) {
    console.log('\nNothing to do.');
  } else if (DRY_RUN) {
    console.log('\n--dry-run: nothing was written.');
  } else {
    await activities.insertMany(pending);
    console.log(`\nWrote ${pending.length} optimisation ${pending.length === 1 ? 'activity' : 'activities'}.`);
    const counts = await activities
      .aggregate([{ $group: { _id: '$cluster', n: { $sum: 1 } } }, { $sort: { n: -1 } }])
      .toArray();
    console.log('Dashboard now reads:');
    for (const row of counts) console.log(`  ${(row._id || '(unassigned)').padEnd(12)} ${row.n}`);
  }

  await disconnectClusters();
  await disconnectDB();
  await mongoose.disconnect().catch(() => {});
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Backfill failed:', err.message);
    process.exit(1);
  });
