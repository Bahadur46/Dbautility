'use strict';

/**
 * Checks every configured cluster before you rely on it.
 *
 * For each CLUSTER_*_URI in .env it connects, reports the database it landed on
 * and how much is already there. The login accounts are not per-cluster — they
 * live in the application's own database (MONGODB_URI) — so those are listed
 * once, with the cluster each account is pinned to. Nothing is written.
 *
 *   npm run check:clusters
 */

const mongoose = require('mongoose');
const clusters = require('../config/clusters');
const { connectDB, disconnectDB } = require('../config/db');
const {
  connectCluster,
  runWithCluster,
  runOnAuthDb,
  disconnectClusters,
} = require('../config/clusterConnections');
const User = require('../models/User');
const ManualIndex = require('../models/ManualIndex');
const AuditLog = require('../models/AuditLog');

/* eslint-disable no-console */
async function run() {
  if (!clusters.isEnabled()) {
    console.log('No clusters are configured — the app runs in single-database mode.');
    console.log('Set CLUSTER_ANANDA_URI / CLUSTER_DOTIN_URI / CLUSTER_COLSTON_URI /');
    console.log('CLUSTER_KAMDHENU_URI in backend/.env, then run this again.');
    return;
  }

  console.log(`Configured clusters: ${clusters.clusters.map((c) => c.label).join(', ')}\n`);

  // The application's own database first: the accounts and the audit trail are
  // deployment-wide, so both are read over this connection and neither can be
  // counted until it is up.
  await connectDB();
  console.log('');

  let failed = 0;
  for (const cluster of clusters.clusters) {
    try {
      const connection = await connectCluster(cluster.key);
      // The index definitions come from the cluster's own database; the audit
      // entries come from the central trail, narrowed to this cluster.
      const [indexes, logs] = await runWithCluster(cluster.key, () =>
        Promise.all([
          ManualIndex.countDocuments(),
          AuditLog.countDocuments({ cluster: cluster.key }),
        ])
      );
      console.log(`  OK    ${cluster.label.padEnd(10)} db=${connection.name}`);
      console.log(`        ${indexes} manual index(es), ${logs} audit entr(ies)`);
      // Accounts are per cluster, so they are listed with the cluster they
      // belong to rather than once at the end.
      // LoginTB holds the sign-in history alongside the accounts, and only an
      // account row carries UserName — without this the history rows come back
      // too and there is nothing to print for them.
      const users = await runOnAuthDb(
        () =>
          User.find({
            UserName: { $exists: true },
            // This cluster's own accounts, plus any left unpinned — which are
            // the accounts every cluster accepts.
            cluster: { $in: [cluster.key, ''] },
          }).sort({ UserName: 1 }),
        cluster
      );
      for (const u of users) {
        const scope = u.cluster ? `pinned to ${u.cluster}` : cluster.label;
        console.log(
          `        ${u.UserName.padEnd(14)} ${u.role.padEnd(6)} → ${scope}${u.isActive ? '' : '  (disabled)'}`
        );
      }
      if (!users.length) console.log('        no login accounts in this cluster');
    } catch (err) {
      failed += 1;
      console.log(`  FAIL  ${cluster.label.padEnd(10)} ${err.message}`);
    }
  }

  console.log(
    failed
      ? `\n${failed} cluster(s) could not be reached — check the URI, the database user, and Atlas Network Access.`
      : '\nAll clusters reachable.'
  );
}

run()
  .catch((err) => {
    console.error('[check:clusters] Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectClusters();
    await disconnectDB();
    await mongoose.disconnect().catch(() => {});
    process.exit(process.exitCode || 0);
  });
