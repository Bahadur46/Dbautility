'use strict';

const mongoose = require('mongoose');
const { config } = require('./env');
const { startInMemoryMongo, stopInMemoryMongo } = require('./memoryDb');

mongoose.set('strictQuery', true);

const CONNECT_TIMEOUT_MS = 10000;

// 'connecting' while the first attempt is still running, 'mongodb' once
// connected to the configured database, 'in-memory' when the fallback is in
// use, 'unavailable' when neither could be reached, 'disconnected' after a
// clean shutdown. Reported by /api/health.
let dbMode = 'connecting';

// Why the database is unavailable, for /api/health and for the 503 the data
// routes answer with. Null whenever the database is usable.
let dbError = null;

// How long the in-memory fallback gets to come up. It downloads a ~200 MB
// mongod binary on first use, and on a fresh deployment the cache is always
// empty — so without a bound a hosted boot can hang on that download until the
// platform gives up on the container and serves 503 with nothing in the log.
const FALLBACK_START_TIMEOUT_MS =
  parseInt(process.env.INMEMORY_STARTUP_TIMEOUT_MS, 10) || 60000;

/** Reject rather than wait forever, so a slow download cannot wedge the boot. */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Hide the password when echoing a connection string back to the operator. */
function maskUri(uri = '') {
  return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
}

function attachConnectionListeners() {
  mongoose.connection.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[db] Connection error:', err.message);
  });
  mongoose.connection.on('disconnected', () => {
    // eslint-disable-next-line no-console
    console.warn('[db] Disconnected from MongoDB');
  });
}

/** Single connection attempt, with a hard timeout so it can never hang. */
async function attempt(uri) {
  const hardTimeout = new Promise((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`No response from MongoDB after ${CONNECT_TIMEOUT_MS / 1000}s`)),
      CONNECT_TIMEOUT_MS + 2000
    );
    timer.unref();
  });

  return Promise.race([
    mongoose.connect(uri, {
      serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
      connectTimeoutMS: CONNECT_TIMEOUT_MS,
      maxPoolSize: 20,
    }),
    hardTimeout,
  ]);
}

/** Explain, in the terminal, why the configured database could not be reached. */
function printDiagnostics(uri, err) {
  /* eslint-disable no-console */
  console.error('\n──────────────────────────────────────────────────────────');
  console.error(' CANNOT CONNECT TO THE CONFIGURED MONGODB');
  console.error('──────────────────────────────────────────────────────────');
  console.error(` Tried : ${maskUri(uri)}`);
  console.error(` Reason: ${err.message}\n`);

  if (uri.startsWith('028_db_user:HDTiC60Z7wBPxaey@clusterdhs.c0ai6pq.mongodb.net/')) {
    console.error(' This is a MongoDB Atlas cluster. Check, in order:');
    console.error('   1. Atlas > Network Access > Add IP Address.');
    console.error('      Add your current IP (or 0.0.0.0/0 for development).');
    console.error('      This is the most common cause of a timeout here.');
    console.error('   2. Atlas > Database Access: the user name and password in');
    console.error('      MONGODB_URI must match, and the user needs readWrite.');
    console.error('   3. If your password contains @ : / ? # or %, it must be');
    console.error('      percent-encoded in the connection string.');
    console.error('   4. A company VPN or firewall may block outbound 27017.');
  } else {
    console.error(' Fix one of these:');
    console.error('   1. Start MongoDB locally, then run this again.');
    console.error('      Docker:  docker run -d -p 27017:27017 --name mongo mongo:7');
    console.error('      Windows: net start MongoDB      (as Administrator)');
    console.error('   2. Or point MONGODB_URI in backend/.env at a MongoDB Atlas cluster.');
  }
  console.error('──────────────────────────────────────────────────────────\n');
  /* eslint-enable no-console */
}

/**
 * Connect to the configured MongoDB.
 *
 * If that fails and the in-memory fallback is enabled (the default outside
 * production), the API starts anyway on an embedded database preloaded with
 * sample data, so the application is always usable. The fallback is announced
 * loudly and never engages when NODE_ENV=production, where a database outage
 * must stop the boot rather than silently serve throwaway data.
 */
async function connectDB(uri = config.mongoUri) {
  // eslint-disable-next-line no-console
  console.log(`[db] Connecting to ${maskUri(uri)} …`);

  try {
    const conn = await attempt(uri);
    dbMode = 'mongodb';
    dbError = null;
    attachConnectionListeners();
    // eslint-disable-next-line no-console
    console.log(`[db] Connected to MongoDB: ${conn.connection.name}`);
    return conn;
  } catch (err) {
    printDiagnostics(uri, err);

    if (!config.allowInMemoryFallback) {
      // eslint-disable-next-line no-console
      console.error(
        config.isProduction
          ? ' Refusing to use the in-memory fallback: it is disabled in production.\n'
          : ' The in-memory fallback is disabled (ALLOW_INMEMORY_FALLBACK=false).\n'
      );
      dbMode = 'unavailable';
      dbError = err.message;
      throw err;
    }

    // Mongoose may still be retrying the failed target in the background.
    await mongoose.connection.close().catch(() => {});

    /* eslint-disable no-console */
    console.warn('──────────────────────────────────────────────────────────');
    console.warn(' STARTING ON A TEMPORARY IN-MEMORY DATABASE');
    console.warn('──────────────────────────────────────────────────────────');
    console.warn(' The app is fully usable, preloaded with sample data.');
    console.warn(' Everything you create here is LOST when the server stops.');
    console.warn(' Fix MONGODB_URI above to use your real database.');
    console.warn('──────────────────────────────────────────────────────────\n');
    /* eslint-enable no-console */

    let memoryUri;
    try {
      memoryUri = await withTimeout(
        startInMemoryMongo(),
        FALLBACK_START_TIMEOUT_MS,
        'The in-memory database'
      );
    } catch (fallbackErr) {
      /* eslint-disable no-console */
      console.error(' The in-memory fallback could not start either.');
      console.error(` Reason: ${fallbackErr.message}`);
      console.error(' Fix the database connection above, or run "npm install".\n');
      /* eslint-enable no-console */
      dbMode = 'unavailable';
      dbError = `${err.message} (the in-memory fallback also failed: ${fallbackErr.message})`;
      throw err; // report the original database failure, not the fallback's
    }

    const conn = await attempt(memoryUri);
    dbMode = 'in-memory';
    dbError = null;
    attachConnectionListeners();

    // Loaded here rather than at import time to avoid a circular dependency.
    const { loadSampleData } = require('../scripts/sampleData');
    const counts = await loadSampleData({ quiet: true });
    // eslint-disable-next-line no-console
    console.log(
      `[db] In-memory database ready — ${counts.manualIndexes} sample indexes, ${counts.auditLogs} audit entries.`
    );

    return conn;
  }
}

async function disconnectDB() {
  await mongoose.connection.close().catch(() => {});
  await stopInMemoryMongo();
  dbMode = 'disconnected';
}

const getDbMode = () => dbMode;

/** Why the database is unavailable, or null when it is usable. */
const getDbError = () => dbError;

/** Whether requests that need the database can be served at all. */
const isDbReady = () => dbMode === 'mongodb' || dbMode === 'in-memory';

module.exports = { connectDB, disconnectDB, getDbMode, getDbError, isDbReady };
