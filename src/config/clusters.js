'use strict';

const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
// This module reads process.env directly and may load before config/env.js,
// so it seeds the shipped defaults itself. applyDefaults never overwrites an
// existing value, so doing it twice is harmless.
require('./defaults');

/**
 * The database clusters this deployment serves.
 *
 * Each cluster is a separate MongoDB with its own connection string, manual
 * indexes and audit trail. Sign-in is NOT cluster-wise — one account signs in
 * once, for the whole deployment — but the session is: after logging in the
 * user picks a cluster, and from then on every query, every index and every
 * audit entry is served from that cluster's database only. Picking another
 * cluster is a step on the same session, not a second login.
 *
 * The accounts themselves are central, in the database MONGODB_URI names, so
 * there is one set of credentials however many clusters there are.
 *
 * A cluster is configured with:
 *   CLUSTER_<KEY>_URI        where the cluster's OWN records live — accounts,
 *                            index definitions, audit trail       (optional)
 *   CLUSTER_<KEY>_DATA_URI   the server the indexes are created on, when it is
 *                            a different one. The application writes nothing of
 *                            its own there.                       (optional)
 *   CLUSTER_<KEY>_DB         the database name on the current connection
 *                            (optional, defaults to dba_<key>)
 *   CLUSTER_<KEY>_TARGET_DB  the database indexes are applied to (optional,
 *                            defaults to TARGET_DB, then the URI's database)
 *
 * A cluster connects over CLUSTER_<KEY>_URI. With none configured it falls
 * back to the server MONGODB_URI names — the deployment's own, which already
 * holds the accounts — in its own database: `dba_<key>`, unless CLUSTER_<KEY>_DB
 * says otherwise. CLUSTER_<KEY>_DATA_URI is never used for this: it reaches a
 * customer's data server, which the application must leave untouched.
 */
const DEFINITIONS = [
  { key: 'ananda', label: 'Ananda' },
  { key: 'dotin', label: 'DotIn' },
  { key: 'colston', label: 'Colston' },
  { key: 'kamdhenu', label: 'Kamdhenu' },
];

const envKey = (key) => key.toUpperCase().replace(/[^A-Z0-9]/g, '_');

// The login connection string. Only used to keep its accounts database out of
// a cluster's browsable list — never to connect a cluster.
const currentUri = (process.env.MONGODB_URI || '').trim();

/**
 * The current connection string pointed at another database.
 *
 * Everything else in the URI — host, credentials, replica set, query options —
 * is left exactly as configured, so every cluster is reached over the same
 * connection this deployment already uses, and only the database differs.
 */
function withDatabase(uri, dbName) {
  if (!uri || !dbName) return uri;
  try {
    const url = new URL(uri);
    url.pathname = `/${dbName}`;
    return url.toString();
  } catch {
    // Not parseable as a URL — rewrite the path segment between the host and
    // the query string instead.
    return uri.replace(/^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/[^?]*)?/, `$1/${dbName}`);
  }
}

/** The database a connection string names, or '' when it names none. */
function databaseOf(uri) {
  if (!uri) return '';
  try {
    return decodeURIComponent(new URL(uri).pathname.replace(/^\//, '')).trim();
  } catch {
    const match = /^mongodb(?:\+srv)?:\/\/[^/?]+\/([^?]*)/.exec(uri);
    return match ? decodeURIComponent(match[1]).trim() : '';
  }
}

const clusters = DEFINITIONS.map((def) => {
  const prefix = `CLUSTER_${envKey(def.key)}`;
  const ownUri = (process.env[`${prefix}_URI`] || '').trim();
  const dataUri = (process.env[`${prefix}_DATA_URI`] || '').trim();
  // A server of its own decides its own database when its URI names one;
  // otherwise, and for a cluster on the shared connection, the cluster's
  // configured name is used.
  const dbName =
    databaseOf(ownUri) || (process.env[`${prefix}_DB`] || '').trim() || `dba_${def.key}`;
  return {
    ...def,
    dbName,
    // Aimed at `dbName`, so a URI that stops at the host still lands on a named
    // database rather than the driver's default.
    // A cluster is reached over its own URI when it has one. With none, its
    // records go in `dbName` on the deployment's own server — the one
    // MONGODB_URI names, where the accounts already are. The data server is
    // NEVER used for this: the application writes nothing of its own there and
    // its user is granted only the databases it reads and indexes, so
    // borrowing it fails on the first insert with 'not authorized on dba_<key>'.
    uri: withDatabase(ownUri || currentUri, dbName),
    shared: false,
    // The server the indexes are created on, when that is NOT the server the
    // cluster's own records live on. This is the case where the application
    // must leave no trace on the data server: nothing of its own is written
    // there — no accounts, no index definitions, no audit trail — it only
    // reads the databases and creates the indexes it is asked for.
    dataUri: dataUri || '',
    targetDb: (process.env[`${prefix}_TARGET_DB`] || '').trim() || databaseOf(dataUri),
  };
}).filter((c) => c.uri);

const byKey = new Map(clusters.map((c) => [c.key, c]));

/**
 * The server a connection string points at — host list and credentials, with
 * the database and options dropped.
 *
 * Two clusters with the same value share one MongoDB server, which is the
 * normal setup: they are separate databases on one Atlas cluster.
 */
function serverOf(uri) {
  const m = String(uri || '').match(/^mongodb(?:\+srv)?:\/\/([^\/?]+)/i);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Databases on a cluster's own server that belong to somebody else.
 *
 * A session may browse every database on its server — that is where the real
 * application data lives — but not the databases the OTHER clusters are served
 * from, nor the application's own accounts database. Those sit on the same
 * server whenever the clusters share one, and reaching them would step straight
 * over the cluster boundary.
 */
function foreignDatabases(cluster) {
  if (!cluster) return [];
  const server = serverOf(cluster.uri);
  const names = [];
  for (const other of clusters) {
    if (other.key === cluster.key) continue;
    // Every other cluster's databases, whichever server they are on: a name
    // that once served another cluster stays out of this one's list even after
    // the cluster has been moved elsewhere.
    names.push(other.dbName);
    if (other.targetDb) names.push(other.targetDb);
  }
  // The accounts database of a single-database deployment, when it shares the
  // server. A cluster's own accounts live in its own database, not here.
  if (currentUri && serverOf(currentUri) === server) {
    const own = currentUri.match(/^mongodb(?:\+srv)?:\/\/[^\/?]+\/([^?]+)/i);
    if (own && own[1]) names.push(decodeURIComponent(own[1]));
  }
  const mine = new Set([cluster.dbName, cluster.targetDb].filter(Boolean));
  return [...new Set(names.filter((n) => n && !mine.has(n)))];
}

/** Normalise whatever the client sent into a known cluster key, or ''. */
function normalizeKey(value) {
  const key = String(value || '')
    .trim()
    .toLowerCase();
  if (byKey.has(key)) return key;
  // Accept the display label too ("DotIn"), so the form can post either.
  const match = clusters.find((c) => c.label.toLowerCase() === key);
  return match ? match.key : '';
}

/** The cluster for a key, or null when it is unknown/unconfigured. */
const getCluster = (key) => byKey.get(normalizeKey(key)) || null;

/** True when this deployment runs cluster-wise rather than on a single database. */
const isEnabled = () => clusters.length > 0;

/** The list the login form renders — no connection strings. */
const listPublic = () => clusters.map(({ key, label }) => ({ key, label }));

/**
 * Every defined cluster, configured or not — what the dashboard shows, so a
 * cluster with no connection string still has its place instead of vanishing.
 */
const listAll = () =>
  DEFINITIONS.map(({ key, label }) => ({ key, label, configured: byKey.has(key) }));

module.exports = {
  DEFINITIONS,
  clusters,
  getCluster,
  normalizeKey,
  isEnabled,
  listPublic,
  listAll,
  foreignDatabases,
};
