'use strict';

const app = require('./app');
const { config, assertEnv } = require('./config/env');
const { connectDB, disconnectDB } = require('./config/db');
const clusters = require('./config/clusters');
const { connectAllClusters, disconnectClusters } = require('./config/clusterConnections');
const { ensureSeedUsers } = require('./services/authService');

async function start() {
  assertEnv();

  if (clusters.isEnabled()) {
    // Cluster-wise deployment: one connection per cluster, each with its own
    // accounts and data. MONGODB_URI is still connected, so /api/health and
    // anything not tied to a session keeps working.
    const results = await connectAllClusters();
    const live = results.filter((r) => r.connected).map((r) => r.label);
    // eslint-disable-next-line no-console
    console.log(`[db] Clusters online: ${live.join(', ') || 'none'}`);
    if (!live.length) throw new Error('No cluster could be reached — check the CLUSTER_*_URI values');
  }

  await connectDB();

  // Creates the admin accounts on first boot (and on every start of the
  // in-memory fallback database, which begins empty).
  const created = await ensureSeedUsers();
  if (created.length) {
    // eslint-disable-next-line no-console
    console.log(`[auth] Seeded admin accounts: ${created.join(', ')}`);
  }

  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] DBA Utility API listening on http://localhost:${config.port} (${config.nodeEnv})`);
  });

  const shutdown = async (signal) => {
    // eslint-disable-next-line no-console
    console.log(`\n[server] ${signal} received, shutting down gracefully…`);
    server.close(async () => {
      await disconnectClusters();
      await disconnectDB();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    // eslint-disable-next-line no-console
    console.error('[server] Unhandled rejection:', reason);
  });
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[server] Failed to start:', err.message);
  process.exit(1);
});
