'use strict';

const app = require('./app');
const { config, assertEnv } = require('./config/env');
const { connectDB, disconnectDB } = require('./config/db');
const clusters = require('./config/clusters');
const { connectAllClusters, disconnectClusters } = require('./config/clusterConnections');
const { ensureSeedUsers } = require('./services/authService');

// Binds the port, tolerating a previous instance that is still letting go of it
// (nodemon restarts, a terminal closed without Ctrl+C). Retries a few times
// before giving up with an actionable message instead of a raw stack trace.
function listenWithRetry(application, port, { retries = 6, delayMs = 1000 } = {}) {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    const tryListen = () => {
      const server = application.listen(port, () => {
        server.removeListener('error', onError);
        // eslint-disable-next-line no-console
        console.log(`[server] DBA Utility API listening on http://localhost:${port} (${config.nodeEnv})`);
        resolve(server);
      });

      const onError = (err) => {
        if (err.code !== 'EADDRINUSE') return reject(err);

        attempt += 1;
        if (attempt <= retries) {
          // eslint-disable-next-line no-console
          console.warn(`[server] Port ${port} busy, retrying (${attempt}/${retries})…`);
          setTimeout(tryListen, delayMs);
          return;
        }

        // eslint-disable-next-line no-console
        console.error(
          `\n[server] Port ${port} is still in use by another process.\n` +
            `         Find it:  netstat -ano | findstr :${port}\n` +
            `         Kill it:  taskkill /PID <PID> /F\n` +
            `         Or run on a different port:  set PORT=5001 && npm run dev\n`
        );
        reject(new Error(`Port ${port} already in use`));
      };

      server.once('error', onError);
    };

    tryListen();
  });
}

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

  const server = await listenWithRetry(app, config.port);

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
