'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const mongoose = require('mongoose');

const clusters = require('./clusters');
const { registerAll } = require('../models/registry');

/**
 * One live MongoDB connection per cluster, plus the notion of "the cluster this
 * request belongs to".
 *
 * The active cluster is carried in async local storage rather than passed down
 * through every service call: it is set once, by the user-context middleware,
 * from the `cluster` claim in the session token, and everything the request
 * touches afterwards — models, index creation, the analyzer — resolves against
 * that cluster's connection automatically. Cross-cluster reads are impossible
 * because no code path can reach another connection.
 *
 * Sign-in is part of that isolation: a cluster's login accounts live in the
 * cluster's own database, not in one shared LoginTB. MONGODB_URI stays
 * connected as the fallback for single-database mode and boot-time work, so
 * with no clusters configured the app runs exactly as it did before.
 */

const CONNECT_TIMEOUT_MS = 10000;

const storage = new AsyncLocalStorage();
const connections = new Map(); // cluster key -> mongoose.Connection
// The data servers, for clusters whose indexes are created somewhere other
// than where their own records live. Nothing of the application's is ever
// written through these: no model is compiled on them, they only carry the
// driver client that reads databases and creates indexes.
const dataConnections = new Map(); // cluster key -> mongoose.Connection

/** Load the model files once, so every schema is registered before we compile. */
let modelsLoaded = false;
function loadModelDefinitions() {
  if (modelsLoaded) return;
  modelsLoaded = true;
  require('../models/User');
  require('../models/ManualIndex');
  require('../models/AuditLog');
  require('../models/LoginRecord');
}

/** Open (or reuse) the connection for a cluster and compile its models. */
async function connectCluster(key) {
  const cluster = clusters.getCluster(key);
  if (!cluster) throw new Error(`Unknown cluster "${key}"`);

  const existing = connections.get(cluster.key);
  if (existing) return existing;

  loadModelDefinitions();

  const connection = mongoose.createConnection(cluster.uri, {
    serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    connectTimeoutMS: CONNECT_TIMEOUT_MS,
    maxPoolSize: 20,
  });

  connection.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error(`[db:${cluster.key}] Connection error:`, err.message);
  });

  await connection.asPromise();
  connections.set(cluster.key, connection);
  registerAll(connection);

  if (cluster.dataUri) {
    const data = mongoose.createConnection(cluster.dataUri, {
      serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
      connectTimeoutMS: CONNECT_TIMEOUT_MS,
      maxPoolSize: 10,
    });
    data.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error(`[db:${cluster.key}/data] Connection error:`, err.message);
    });
    await data.asPromise();
    dataConnections.set(cluster.key, data);
    // Deliberately no registerAll(): the data server holds no model of ours.
    // eslint-disable-next-line no-console
    console.log(`[db:${cluster.key}/data] Indexes are created on ${data.host || 'the data server'}`);
  }
  // eslint-disable-next-line no-console
  console.log(`[db:${cluster.key}] Connected to ${connection.name} (${cluster.label})`);
  return connection;
}

/** Connect every configured cluster. Failures are reported, not fatal. */
async function connectAllClusters() {
  const results = [];
  for (const cluster of clusters.clusters) {
    try {
      await connectCluster(cluster.key);
      results.push({ ...cluster, connected: true });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[db:${cluster.key}] Could not connect: ${err.message}`);
      results.push({ ...cluster, connected: false, error: err.message });
    }
  }
  return results;
}

/** The already-open connection for a cluster, or null. */
const getConnection = (key) => connections.get(clusters.normalizeKey(key)) || null;

/** Run `fn` — and everything it awaits — against one cluster's database. */
function runWithCluster(key, fn) {
  const cluster = clusters.getCluster(key);
  const connection = cluster ? connections.get(cluster.key) : null;
  if (!cluster || !connection) return fn();
  return storage.run({ cluster, connection }, fn);
}

/** The cluster the current request belongs to, or null in single-database mode. */
const activeCluster = () => storage.getStore()?.cluster || null;

/**
 * The connection MONGODB_URI names, whatever cluster the request is on.
 *
 * This is where the records that belong to the deployment rather than to any
 * one cluster live — the audit trail. Models marked `central` in the registry
 * resolve here and nowhere else, so an entry written while working on one
 * cluster still lands in the one shared trail.
 */
function centralConnection() {
  registerAll(mongoose.connection);
  return mongoose.connection;
}

/**
 * Run `fn` against a cluster's own accounts database.
 *
 * Sign-in is cluster-wise: LoginTB (and the login history beside it) lives in
 * the cluster's own database, so Ananda's accounts are in Ananda's database and
 * Kamdhenu's in Kamdhenu's. Which cluster is being signed in to therefore
 * decides which accounts are consulted, and an account in one cluster is
 * invisible to every other.
 *
 * The cluster is taken from the argument, or the ambient one when none is
 * given. With no cluster — single-database mode, and boot-time work — this is
 * the default connection, which is the behaviour that has always applied there.
 */
function runOnAuthDb(fn, cluster = null) {
  const target = cluster || storage.getStore()?.cluster || null;
  const key = target ? target.key || target : null;
  const resolved = key ? clusters.getCluster(key) : null;
  const connection = (resolved && connections.get(resolved.key)) || centralConnection();
  return storage.run({ cluster: resolved, connection }, fn);
}

/**
 * The connection everything in the current request must use.
 *
 * Falls back to the default connection, which is what single-database mode and
 * boot-time work (seeding, scripts) run on.
 */
function activeConnection() {
  const store = storage.getStore();
  if (store) return store.connection;
  if (mongoose.connection.readyState) {
    registerAll(mongoose.connection);
    return mongoose.connection;
  }
  return mongoose.connection;
}

/**
 * The connection indexes are created over for the current request.
 *
 * A cluster with its own data server uses that; every other cluster creates its
 * indexes on the same connection its records live on, which is the original
 * behaviour and stays unchanged.
 */
function activeDataConnection() {
  const cluster = storage.getStore()?.cluster;
  const data = cluster ? dataConnections.get(cluster.key) : null;
  return data || activeConnection();
}

/** The database indexes are applied to for the active cluster, if it names one. */
const activeTargetDb = () => storage.getStore()?.cluster?.targetDb || '';

async function disconnectClusters() {
  for (const connection of [...connections.values(), ...dataConnections.values()]) {
    await connection.close().catch(() => {});
  }
  connections.clear();
  dataConnections.clear();
}

module.exports = {
  connectCluster,
  connectAllClusters,
  disconnectClusters,
  getConnection,
  runWithCluster,
  runOnAuthDb,
  centralConnection,
  activeCluster,
  activeConnection,
  activeDataConnection,
  activeTargetDb,
};
