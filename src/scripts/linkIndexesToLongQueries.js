'use strict';

/**
 * Link the indexes already on the dashboard to the long queries they fixed.
 *
 * Linking only happens as work is recorded, so every index created before it
 * shipped is unlinked and the dashboard still counts one fixed query as the
 * query plus each of its indexes. This applies the same rule the server now
 * uses live (see services/indexLinkService.js): an index belongs to the long
 * query on the same collection whose fields it serves, best match first.
 *
 *   node src/scripts/linkIndexesToLongQueries.js --dry-run
 *   node src/scripts/linkIndexesToLongQueries.js
 *
 * Safe to run twice: only unlinked indexes are considered, and a link someone
 * set by hand is never replaced. Only `longQueryId` is written.
 */

const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../config/db');
const { connectAllClusters, disconnectClusters } = require('../config/clusterConnections');
const clusters = require('../config/clusters');
const OptimizationActivity = require('../models/OptimizationActivity');
const indexLinkService = require('../services/indexLinkService');

/* eslint-disable no-console */

const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
  await connectDB();
  if (clusters.isEnabled()) await connectAllClusters();

  const indexes = await OptimizationActivity.find({ activityType: 'INDEX_CREATED', longQueryId: null })
    .sort({ timestamp: 1 })
    .lean();
  console.log(`Unlinked indexes: ${indexes.length}`);

  const tasks = new Map(); // long query id -> index names
  for (const index of indexes) {
    const best = await indexLinkService.bestLongQueryFor(index);
    if (!best) continue;
    const key = String(best.query._id);
    if (!tasks.has(key)) tasks.set(key, []);
    tasks.get(key).push({ ...index, best });
  }

  const linked = [...tasks.values()].reduce((n, list) => n + list.length, 0);
  console.log(`To link: ${linked} indexes to ${tasks.size} long queries`);
  for (const [taskId, list] of tasks) {
    const { cluster, databaseName, collectionName } = list[0];
    console.log(`  ${taskId}  ${cluster}/${databaseName}.${collectionName}  <- ${list.map((i) => `${i.subject} [${i.best.match.method} ${i.best.match.score}]`).join(', ')}`);
  }
  console.log(`Left standalone: ${indexes.length - linked}`);

  if (!linked) {
    console.log('\nNothing to do.');
  } else if (DRY_RUN) {
    console.log('\n--dry-run: nothing was written.');
  } else {
    for (const list of tasks.values()) {
      for (const index of list) await indexLinkService.saveLink(index._id, index.best);
    }
    console.log(`\nLinked ${linked} indexes.`);
  }

  await disconnectClusters();
  await disconnectDB();
  await mongoose.disconnect().catch(() => {});
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Linking failed:', err.message);
    process.exit(1);
  });
