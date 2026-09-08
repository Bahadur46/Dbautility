'use strict';

const mongoose = require('mongoose');
const { config } = require('./env');
const { startInMemoryMongo, stopInMemoryMongo } = require('./memoryDb');

mongoose.set('strictQuery', true);

const CONNECT_TIMEOUT_MS = 10000;

// 'mongodb' once connected to the configured database, 'in-memory' when the
// fallback is in use, 'disconnected' before boot. Reported by /api/health.
let dbMode = 'disconnected';

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

  if (uri.startsWith('mongodb+srv://')) {
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
          ? ' Refusing to start: the in-memory fallback is disabled in production.\n'
          : ' The in-memory fallback is disabled (ALLOW_INMEMORY_FALLBACK=false).\n'
      );
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
      memoryUri = await startInMemoryMongo();
    } catch (fallbackErr) {
      /* eslint-disable no-console */
      console.error(' The in-memory fallback could not start either.');
      console.error(` Reason: ${fallbackErr.message}`);
      console.error(' Fix the database connection above, or run "npm install".\n');
      /* eslint-enable no-console */
      throw err; // report the original database failure, not the fallback's
    }

    const conn = await attempt(memoryUri);
    dbMode = 'in-memory';
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

module.exports = { connectDB, disconnectDB, getDbMode };
