'use strict';

/**
 * Loads sample Manual Indexes so the dashboard is not empty on first run.
 * Each record goes through the audit service, so the Audit Logs page has real
 * entries too.
 *
 *   npm run seed
 *   npm run seed -- --cluster=ananda   (cluster-wise deployments)
 */

const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../config/db');
const { loadSampleData } = require('./sampleData');
const clusters = require('../config/clusters');
const { connectCluster, runWithCluster } = require('../config/clusterConnections');

async function run() {
  const arg = (process.argv.find((a) => a.startsWith('--cluster=')) || '').split('=')[1];

  // Sample data belongs to one cluster's database, so cluster-wise deployments
  // must say which — there is no "all clusters" default worth guessing at.
  if (clusters.isEnabled()) {
    const cluster = clusters.getCluster(arg);
    if (!cluster) {
      const names = clusters.listPublic().map((c) => c.key).join(', ');
      throw new Error(`Name the cluster to seed: npm run seed -- --cluster=<${names}>`);
    }
    await connectCluster(cluster.key);
    const clusterCounts = await runWithCluster(cluster.key, () => loadSampleData({ reset: true }));
    // eslint-disable-next-line no-console
    console.log(`[seed] Done (${cluster.label}):`, clusterCounts);
    await mongoose.disconnect().catch(() => {});
    process.exit(0);
  }

  await connectDB();
  const counts = await loadSampleData({ reset: true });
  // eslint-disable-next-line no-console
  console.log('[seed] Done:', counts);

  await disconnectDB();
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[seed] Failed:', err.message);
  process.exit(1);
});
