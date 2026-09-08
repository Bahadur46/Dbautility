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

  // The port is bound BEFORE the database is touched, and on purpose.
  //
  // Connecting first means every database problem becomes a process that never
  // listens, which a hosting platform can only report as its own 503 page —
  // no route answers, so nothing can say what went wrong. Listening first, the
  // API is always reachable: /api/health names the exact failure and the data
  // routes answer 503 with the reason (see middleware/requireDatabase).
  const server = await listenWithRetry(app, config.port);

  // Deliberately not awaited: the database comes up alongside the server
  // rather than gating it, and initDatabase never rejects.
  initDatabase();

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

/**
 * Bring up the database, reporting failure instead of dying from it.
 *
 * A database that cannot be reached is a serious problem, but it is not a
 * reason to take the whole API down: the operator still needs an endpoint that
 * tells them what is wrong, and the state is often fixed from outside the
 * process (a connection string corrected, a firewall rule added) without any
 * code change. `connectDB` records the failure, so /api/health reports it and
 * every data route answers 503 with the reason.
 */
async function initDatabase() {
  try {
    if (clusters.isEnabled()) {
      // Cluster-wise deployment: one connection per cluster, each with its own
      // accounts and data. MONGODB_URI is still connected, so /api/health and
      // anything not tied to a session keeps working.
      const results = await connectAllClusters();
      const live = results.filter((r) => r.connected).map((r) => r.label);
      // eslint-disable-next-line no-console
      console.log(`[db] Clusters online: ${live.join(', ') || 'none'}`);
      if (!live.length) {
        // eslint-disable-next-line no-console
        console.error('[db] No cluster could be reached — check the CLUSTER_* values');
      }
    }

    await connectDB();

    // Creates the admin accounts on first boot (and on every start of the
    // in-memory fallback database, which begins empty).
    const created = await ensureSeedUsers();
    if (created.length) {
      // eslint-disable-next-line no-console
      console.log(`[auth] Seeded admin accounts: ${created.join(', ')}`);
    }
  } catch (err) {
    /* eslint-disable no-console */
    console.error(`[db] The database is unavailable: ${err.message}`);
    console.error('[db] The API is still listening — GET /api/health for the current state.');
    /* eslint-enable no-console */
  }
}

start().catch((err) => {
  // Only a failure to bind the port reaches here; the database no longer
  // brings the process down.
  // eslint-disable-next-line no-console
  console.error('[server] Failed to start:', err.message);
  process.exit(1);
});
