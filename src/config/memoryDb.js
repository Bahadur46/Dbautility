'use strict';

/**
 * Temporary in-memory MongoDB used as an automatic fallback when the
 * configured database cannot be reached.
 *
 * Backed by `mongodb-memory-server`, which runs a real mongod process on
 * Windows, macOS and Linux. The binary is downloaded once on first use and
 * cached, so later starts are offline and immediate.
 *
 * Data lives only for the lifetime of the process. This is a development
 * convenience — `connectDB` never engages it when NODE_ENV=production.
 */

let server = null;

/** Start the temporary server and return a connection URI for it. */
async function startInMemoryMongo() {
  // Required lazily: it is a devDependency, absent from production installs.
  let MongoMemoryServer;
  try {
    ({ MongoMemoryServer } = require('mongodb-memory-server'));
  } catch {
    throw new Error(
      'mongodb-memory-server is not installed. Run "npm install" in the backend folder, ' +
        'or set ALLOW_INMEMORY_FALLBACK=false in .env to disable the fallback.'
    );
  }

  /* eslint-disable no-console */
  console.log('[db] Starting a temporary in-memory MongoDB …');
  console.log('[db] On the very first run this downloads a MongoDB binary (~200 MB).');
  console.log('[db] It is cached afterwards, so later starts are instant and offline.');
  /* eslint-enable no-console */

  server = await MongoMemoryServer.create({ instance: { dbName: 'dba_utility' } });
  return server.getUri('dba_utility');
}

async function stopInMemoryMongo() {
  if (!server) return;
  try {
    await server.stop();
  } catch {
    /* shutting down anyway */
  }
  server = null;
}

module.exports = { startInMemoryMongo, stopInMemoryMongo };
