'use strict';

/**
 * One-off cleanup after accounts moved into each cluster's own database.
 *
 * Two things are left over from the arrangement before it, and both are
 * removed here. Nothing else is touched, and the cluster databases keep every
 * account they hold.
 *
 *   1. The stray unique indexes on LoginTB.
 *
 *      `userId_1` and `UserName_1` are unique on the bare field, with no
 *      partial filter. LoginTB holds the sign-in history as well as the
 *      accounts, and a history row carries a userId but no UserName — so it
 *      collides with the account row it belongs to and the write is rejected
 *      (E11000). The correct pair, `account_userId_unique` and
 *      `account_username_unique`, is scoped to rows that have a UserName and
 *      stays exactly as it is.
 *
 *   2. The administrator rows still sitting in the central database.
 *
 *      Accounts now live with their cluster, so the rows MONGODB_URI's database
 *      still holds — u-1001-ananda and friends — are duplicates of accounts that
 *      exist in the cluster databases proper. The audit trail in that database
 *      is NOT touched: it is deployment-wide and belongs there.
 *
 * Safe to run twice: it drops only what it finds and reports what it did.
 *
 *   node src/scripts/cleanupCentralAccounts.js
 */

// A cleanup must never run against the throwaway in-memory database — it would
// report success having touched nothing real.
process.env.ALLOW_INMEMORY_FALLBACK = 'false';

const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../config/db');
const clusters = require('../config/clusters');
const {
  connectAllClusters,
  disconnectClusters,
  getConnection,
} = require('../config/clusterConnections');

const STRAY = ['userId_1', 'UserName_1'];

/* eslint-disable no-console */
async function run() {
  await connectDB();
  await connectAllClusters();

  console.log('\nStray unique indexes on LoginTB:');
  let dropped = 0;
  for (const cluster of clusters.clusters) {
    const connection = getConnection(cluster.key);
    if (!connection) {
      console.log(`  ${cluster.label.padEnd(10)} not connected — skipped, run again when it is reachable`);
      continue;
    }
    const col = connection.collection('LoginTB');
    let found = false;
    for (const index of await col.indexes()) {
      if (STRAY.includes(index.name) && index.unique && !index.partialFilterExpression) {
        await col.dropIndex(index.name);
        console.log(`  ${connection.name.padEnd(14)} dropped ${index.name}`);
        dropped += 1;
        found = true;
      }
    }
    if (!found) console.log(`  ${connection.name.padEnd(14)} nothing to drop`);
  }

  console.log('\nAccounts left in the central database:');
  const central = mongoose.connection.collection('LoginTB');
  const rows = await central.find({ UserName: { $exists: true } }).toArray();
  for (const row of rows) {
    console.log(`  ${row.userId.padEnd(18)} ${row.UserName.padEnd(10)} cluster=${row.cluster || '(none)'}`);
  }
  let deleted = 0;
  if (rows.length) {
    const result = await central.deleteMany({ UserName: { $exists: true } });
    deleted = result.deletedCount || 0;
    console.log(`  deleted ${deleted}`);
  } else {
    console.log('  none');
  }

  console.log(`\nDone — ${dropped} index(es) dropped, ${deleted} account row(s) removed.`);
}

run()
  .catch((err) => {
    console.error('[cleanup] Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectClusters();
    await disconnectDB();
    await mongoose.disconnect().catch(() => {});
    process.exit(process.exitCode || 0);
  });
/* eslint-enable no-console */
