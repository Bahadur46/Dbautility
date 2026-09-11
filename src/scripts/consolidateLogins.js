'use strict';

/**
 * Move every cluster's login accounts into the one login database.
 *
 * Sign-in used to be cluster-wise: each cluster database carried its own
 * LoginTB, so the same person had one account per cluster. Login is now a
 * single act for the whole deployment — one username, one password, the cluster
 * chosen afterwards inside the app — and the accounts live only in the database
 * MONGODB_URI names (dba_utility). This script carries the existing accounts
 * there so nobody is locked out by the change.
 *
 * What it does with what it finds:
 *   - a username that exists in SEVERAL clusters is one person with one
 *     password, so it becomes one account with its cluster pin CLEARED — it may
 *     work on any cluster, which is the point of a single login;
 *   - a username that exists in only ONE cluster keeps its pin, so it still
 *     reaches that cluster and no other;
 *   - a user id already taken by a different username is reassigned, because
 *     ids only had to be unique per cluster before and must be unique now;
 *   - an account already present in the login database is left exactly as it
 *     is — the script never overwrites a live credential, and can be re-run.
 *
 * The sign-in history rows sitting beside the accounts are carried over too,
 * each keeping the cluster it was made against.
 *
 * The cluster databases are NOT modified: nothing is deleted there. Once the
 * app is running on the consolidated accounts, the old LoginTB rows can be
 * removed by hand.
 *
 *   node src/scripts/consolidateLogins.js           # report only, writes nothing
 *   node src/scripts/consolidateLogins.js --apply   # perform the move
 */

const mongoose = require('mongoose');

const { config } = require('../config/env');
const clusters = require('../config/clusters');

const apply = process.argv.includes('--apply');

/** Accounts and history rows share LoginTB; only attempts carry an outcome. */
const IS_ACCOUNT = { outcome: { $exists: false } };
const IS_ATTEMPT = { outcome: { $exists: true } };

/**
 * Hand out the next free "u-NNNN" id.
 *
 * The highest id is read from the set on every call, not once: ids are added to
 * that set as accounts are moved, and a ceiling computed up front would hand
 * the same id out twice — the very collision this exists to resolve.
 */
function nextId(taken) {
  return () => {
    let n = 1000;
    for (const id of taken) {
      const parsed = /^u-(\d+)$/.exec(String(id));
      if (parsed) n = Math.max(n, parseInt(parsed[1], 10));
    }
    const id = `u-${n + 1}`;
    taken.add(id);
    return id;
  };
}

async function main() {
  if (!clusters.isEnabled()) {
    // eslint-disable-next-line no-console
    console.log('[consolidate] No clusters configured — the accounts are already central.');
    return;
  }

  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 20000 });
  const login = mongoose.connection;
  // eslint-disable-next-line no-console
  console.log(`[consolidate] Login database: ${login.name}${apply ? '' : '  (dry run)'}`);

  const target = login.collection('LoginTB');
  const existing = await target.find(IS_ACCOUNT).toArray();
  const byName = new Map(existing.map((a) => [String(a.UserName || '').toLowerCase(), a]));
  const takenIds = new Set(existing.map((a) => a.userId).filter(Boolean));
  const takenSessions = new Set(
    (await target.find(IS_ATTEMPT).project({ sessionId: 1 }).toArray())
      .map((r) => r.sessionId)
      .filter(Boolean)
  );

  // Every cluster's accounts, gathered before anything is written, so a
  // username's presence in more than one cluster is known when it is moved.
  const found = new Map(); // username -> [{ cluster, account }]
  const attempts = [];
  for (const cluster of clusters.clusters) {
    if (cluster.dbName === login.name) continue; // already the login database
    const source = login.useDb(cluster.dbName).collection('LoginTB');
    for (const account of await source.find(IS_ACCOUNT).toArray()) {
      const name = String(account.UserName || '').trim().toLowerCase();
      if (!name) continue;
      if (!found.has(name)) found.set(name, []);
      found.get(name).push({ cluster, account });
    }
    for (const row of await source.find(IS_ATTEMPT).toArray()) {
      attempts.push({ cluster, row });
    }
  }

  const allocate = nextId(takenIds);
  const inserts = [];
  for (const [name, rows] of found) {
    if (byName.has(name)) {
      // eslint-disable-next-line no-console
      console.log(`  = ${name} — already in ${login.name}, left untouched`);
      continue;
    }
    // The first cluster's copy wins; they are the same person with the same
    // password, and a difference between copies cannot be resolved here.
    const { account } = rows[0];
    const where = rows.map((r) => r.cluster.key);
    const doc = { ...account };
    delete doc._id;

    // Present in several clusters — one login for all of them, so no pin.
    if (rows.length > 1) doc.cluster = '';

    if (!doc.userId || takenIds.has(doc.userId)) {
      const replacement = allocate();
      // eslint-disable-next-line no-console
      console.log(`    id ${doc.userId || '(none)'} is taken — using ${replacement}`);
      doc.userId = replacement;
    } else {
      takenIds.add(doc.userId);
    }

    inserts.push(doc);
    byName.set(name, doc);
    // eslint-disable-next-line no-console
    console.log(
      `  + ${name} — from ${where.join(', ')} → ${doc.userId}, ` +
        `cluster ${doc.cluster ? `pinned to ${doc.cluster}` : 'unpinned (any)'}`
    );
  }

  // History rows, skipping any already carried over on an earlier run.
  const historyInserts = [];
  for (const { cluster, row } of attempts) {
    if (row.sessionId && takenSessions.has(row.sessionId)) continue;
    const doc = { ...row };
    delete doc._id;
    // A row that never recorded its cluster gets the one it was stored under.
    if (!doc.cluster) {
      doc.cluster = cluster.key;
      doc.clusterLabel = cluster.label;
    }
    if (doc.sessionId) takenSessions.add(doc.sessionId);
    historyInserts.push(doc);
  }

  // eslint-disable-next-line no-console
  console.log(
    `[consolidate] ${inserts.length} account(s) and ${historyInserts.length} history row(s) to move`
  );

  if (!apply) {
    // eslint-disable-next-line no-console
    console.log('[consolidate] Dry run — nothing written. Re-run with --apply to perform it.');
  } else {
    if (inserts.length) await target.insertMany(inserts);
    if (historyInserts.length) await target.insertMany(historyInserts);
    // eslint-disable-next-line no-console
    console.log('[consolidate] Done. The cluster databases were not modified.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`[consolidate] Failed: ${err.message}`);
  process.exit(1);
});
