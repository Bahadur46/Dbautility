'use strict';

const {
  activeConnection,
  activeDataConnection,
  activeTargetDb,
  activeCluster,
} = require('../config/clusterConnections');
const clusters = require('../config/clusters');
const ApiError = require('../utils/ApiError');
const { config } = require('../config/env');

/**
 * Applies Manual Index definitions to the live MongoDB database.
 *
 * This is what makes DBA Utility a real tool rather than a registry: an ACTIVE
 * record has a matching index that actually exists in MongoDB, created through
 * `createIndex()` and removed through `dropIndex()`.
 *
 * Safety rules enforced here, not left to callers:
 *   - reserved databases (admin, local, config) and system collections are refused;
 *   - system collections are refused;
 *   - the `_id_` index can never be dropped;
 *   - an index is only dropped when the record itself created it, which is
 *     tracked by `appliedIndexName`. Indexes the application did not create
 *     are never touched.
 */

const PROTECTED_INDEX_NAMES = new Set(['_id_']);

/** Reject collection names that are unsafe or reserved. */
function assertSafeCollection(collectionName) {
  const name = String(collectionName || '').trim();
  if (!name) throw ApiError.badRequest('A collection name is required to create a real index');
  if (name.startsWith('system.')) {
    throw ApiError.forbidden(`Refusing to touch the system collection "${name}"`);
  }
  if (/[$\0]/.test(name)) {
    throw ApiError.badRequest(`Invalid collection name "${name}"`);
  }
  return name;
}

/** Reserved database names that must never be touched. */
const PROTECTED_DATABASES = new Set(['admin', 'local', 'config']);

/**
 * The database indexes are applied to.
 *
 * DBA Utility keeps its own records (manual index definitions, audit logs) in
 * the database from the connection string, but the indexes it manages usually
 * belong to a different database entirely — the one holding real application
 * data. Each record therefore carries its own `databaseName`, falling back to
 * TARGET_DB and finally to the connected database.
 *
 * In cluster-wise mode a session sees every database on its own cluster's
 * server — that is where the real application data lives, and picking it is the
 * whole point of the database dropdown. What it may not see are the databases
 * the OTHER clusters are served from: the clusters can share a MongoDB server,
 * so those are one name away, and reaching one would step over the cluster
 * boundary.
 */

/** The databases of other clusters, which this session must not reach. */
function hiddenDatabases() {
  const cluster = activeCluster();
  if (!cluster) return [];
  return clusters.foreignDatabases(cluster);
}

function resolveDatabaseName(databaseName) {
  const cluster = activeCluster();
  // A data server is a place the application only ever reads from and creates
  // asked-for indexes on. Its connection string usually names no database, and
  // the driver's default ("test") would be created on first write — a database
  // of ours on a server that must carry none. So on a data server the target is
  // named explicitly or not at all.
  const fallback = cluster && cluster.dataUri ? '' : activeDataConnection().name;
  const name = String(databaseName || activeTargetDb() || config.targetDb || fallback || '').trim();
  if (!name) {
    throw new ApiError(
      503,
      cluster && cluster.dataUri
        ? `${cluster.label} creates its indexes on a separate data server — name the database, ` +
          `or set CLUSTER_${cluster.key.toUpperCase()}_TARGET_DB`
        : 'No target database is configured'
    );
  }
  if (PROTECTED_DATABASES.has(name)) {
    throw ApiError.forbidden(`Refusing to modify the reserved database "${name}"`);
  }
  if (/[\s\\/."$*<>:|?]/.test(name)) {
    throw ApiError.badRequest(`Invalid database name "${name}"`);
  }

  if (hiddenDatabases().includes(name)) {
    throw ApiError.forbidden(
      `"${name}" belongs to another cluster — you are signed in to ${activeCluster().label}`
    );
  }
  return name;
}

/** The default target database, used when a record does not name one. */
function defaultDatabaseName() {
  const cluster = activeCluster();
  const fallback = cluster && cluster.dataUri ? '' : activeDataConnection().name;
  return String(activeTargetDb() || config.targetDb || fallback || '').trim();
}

function database(databaseName) {
  const conn = activeDataConnection();
  const client = conn && conn.getClient ? conn.getClient() : null;
  if (!client) throw new ApiError(503, 'Database connection is not ready');
  return client.db(resolveDatabaseName(databaseName));
}

function collection(collectionName, databaseName) {
  return database(databaseName).collection(assertSafeCollection(collectionName));
}

/** Turn the stored key array into a MongoDB key specification object. */
const SPECIAL_DIRECTIONS = new Set(['text', 'hashed', '2dsphere', '2d']);

function buildKeySpec(doc) {
  const spec = {};
  for (const key of doc.keys || []) {
    const direction = String(key.direction);
    // 'text', 'hashed', '2dsphere' and '2d' are passed through as strings;
    // everything else is an ordering number.
    spec[key.field] = SPECIAL_DIRECTIONS.has(direction) ? direction : Number(direction);
  }
  return spec;
}

/** Turn the stored options into the options object for createIndex(). */
function buildIndexOptions(doc) {
  const o = doc.options || {};
  const options = { name: doc.indexName };

  if (doc.indexType === 'UNIQUE' || o.unique) options.unique = true;
  if (o.sparse) options.sparse = true;

  if (doc.indexType === 'TTL' && o.expireAfterSeconds !== null && o.expireAfterSeconds !== undefined) {
    options.expireAfterSeconds = Number(o.expireAfterSeconds);
  }

  // A partial condition applies to whatever index type it is attached to.
  if (o.partialFilterExpression && Object.keys(o.partialFilterExpression).length > 0) {
    options.partialFilterExpression = o.partialFilterExpression;
  }

  return options;
}

/** A compact, loggable description of what will be sent to MongoDB. */
function describeSpec(doc) {
  const keys = buildKeySpec(doc);
  const options = buildIndexOptions(doc);
  const { name, ...rest } = options;
  const extras = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
  const db = doc.databaseName || defaultDatabaseName();
  return `${db}.${doc.collectionName}.createIndex(${JSON.stringify(keys)}${extras})`;
}

/**
 * Create the real index in MongoDB.
 * Returns the index name reported by the server.
 */
async function applyIndex(doc) {
  const keys = buildKeySpec(doc);
  if (Object.keys(keys).length === 0) {
    throw ApiError.badRequest('Cannot create an index without at least one key field');
  }

  try {
    return await collection(doc.collectionName, doc.databaseName).createIndex(keys, buildIndexOptions(doc));
  } catch (err) {
    // MongoDB refuses a new index that reuses an existing name with a
    // different specification — surface that clearly instead of a raw driver error.
    if (err.codeName === 'IndexOptionsConflict' || err.code === 85) {
      throw ApiError.conflict(
        `An index named "${doc.indexName}" already exists on "${doc.databaseName || defaultDatabaseName()}.${doc.collectionName}" ` +
          'with a different definition. ' +
          'Drop it in MongoDB first, or choose another name.'
      );
    }
    if (err.codeName === 'IndexKeySpecsConflict' || err.code === 86) {
      throw ApiError.conflict(
        `An index with these keys already exists on "${doc.collectionName}" under a different name.`
      );
    }
    throw ApiError.badRequest(`MongoDB rejected the index: ${err.message}`);
  }
}

/**
 * The mongo shell command equivalent to a dropIndex the server is about to run.
 *
 * Written into the audit entry so the log records the operation itself, not
 * only its effect: the same line can be pasted into mongosh to see exactly
 * what was done, and on which database. The database name is resolved here
 * rather than passed through, so an entry never says "the default database"
 * once the default has moved on.
 */
function dropIndexCommand({ databaseName, collectionName, indexName }) {
  const db = resolveDatabaseName(databaseName);
  const target = db ? `db.getSiblingDB(${JSON.stringify(db)})` : 'db';
  return `${target}.getCollection(${JSON.stringify(collectionName)}).dropIndex(${JSON.stringify(indexName)})`;
}

/**
 * The mongo shell command equivalent to the createIndex the server is about to
 * run — the counterpart of dropIndexCommand, in the same shape, so a CREATE
 * entry and the DROP that undoes it read as the same kind of record.
 */
function createIndexCommand(doc) {
  const db = resolveDatabaseName(doc.databaseName);
  const target = db ? `db.getSiblingDB(${JSON.stringify(db)})` : 'db';
  const keys = buildKeySpec(doc);
  const options = buildIndexOptions(doc);
  const args = Object.keys(options).length
    ? `${JSON.stringify(keys)}, ${JSON.stringify(options)}`
    : JSON.stringify(keys);
  return `${target}.getCollection(${JSON.stringify(doc.collectionName)}).createIndex(${args})`;
}

/**
 * Drop the real index this record created.
 * Missing indexes are treated as success, so the operation is idempotent.
 */
async function dropIndex(doc) {
  const name = (doc.appliedIndexName || '').trim();
  if (!name) return { dropped: false, reason: 'no index was applied by this record' };
  if (PROTECTED_INDEX_NAMES.has(name)) {
    throw ApiError.forbidden(`Refusing to drop the protected index "${name}"`);
  }

  try {
    await collection(doc.collectionName, doc.databaseName).dropIndex(name);
    return { dropped: true };
  } catch (err) {
    // IndexNotFound (27) / NamespaceNotFound (26): nothing to do.
    if (err.code === 27 || err.code === 26 || /index not found|ns not found/i.test(err.message)) {
      return { dropped: false, reason: 'index was already absent' };
    }
    throw ApiError.badRequest(`MongoDB refused to drop the index: ${err.message}`);
  }
}

/** All real indexes currently on a collection. */
async function listCollectionIndexes(collectionName, databaseName) {
  try {
    return await collection(collectionName, databaseName).listIndexes().toArray();
  } catch (err) {
    if (err.code === 26 || /ns does not exist|not found/i.test(err.message)) return [];
    throw err;
  }
}

/** Compare two key specifications for equality, order included. */
function sameKeys(a = {}, b = {}) {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k, i) => bk[i] === k && String(a[k]) === String(b[k]));
}

/**
 * Compare a record against the live database.
 * Used by GET /:id/db-status so drift is visible rather than assumed.
 */
async function getSyncStatus(doc) {
  const shouldExist = doc.status === 'ACTIVE';
  let actual = null;

  try {
    const indexes = await listCollectionIndexes(doc.collectionName, doc.databaseName);
    actual = indexes.find((i) => i.name === (doc.appliedIndexName || doc.indexName)) || null;
  } catch (err) {
    return {
      shouldExist,
      existsInDatabase: false,
      inSync: false,
      message: `Could not read indexes from "${doc.databaseName || defaultDatabaseName()}.${doc.collectionName}": ${err.message}`,
    };
  }

  const existsInDatabase = Boolean(actual);
  const keysMatch = existsInDatabase ? sameKeys(actual.key, buildKeySpec(doc)) : false;
  const inSync = shouldExist ? existsInDatabase && keysMatch : !existsInDatabase;

  let message;
  if (inSync && shouldExist) message = 'The index exists in MongoDB and matches this definition.';
  else if (inSync) message = 'This definition is not active, and no matching index exists in MongoDB.';
  else if (shouldExist && !existsInDatabase) message = 'This index is ACTIVE but is missing from MongoDB. Run Sync to create it.';
  else if (shouldExist && !keysMatch) message = 'An index with this name exists but its keys differ from this definition.';
  else message = 'This definition is not ACTIVE, but a matching index still exists in MongoDB.';

  return {
    shouldExist,
    existsInDatabase,
    keysMatch,
    inSync,
    message,
    definition: buildKeySpec(doc),
    actual: actual ? { name: actual.name, key: actual.key, unique: !!actual.unique } : null,
  };
}

/**
 * Drop an index by name, whether or not this application created it.
 *
 * Separate from `dropIndex` on purpose: that one only ever removes an index a
 * Manual Index record owns, which is the right guard for the CRUD path. This
 * one exists for the analyzer, where the whole point is acting on indexes the
 * application did not create — so it carries its own guards instead.
 */
async function dropIndexByName({ databaseName, collectionName, indexName }) {
  const name = String(indexName || '').trim();
  if (!name) throw ApiError.badRequest('An index name is required');
  if (PROTECTED_INDEX_NAMES.has(name)) {
    throw ApiError.forbidden(`"${name}" is MongoDB's own primary key index and cannot be dropped`);
  }

  const col = collection(collectionName, databaseName);

  // Read it first so the audit entry can record what was actually removed.
  let existing = null;
  try {
    existing = (await col.listIndexes().toArray()).find((i) => i.name === name) || null;
  } catch (err) {
    throw ApiError.badRequest(`Could not read indexes from "${collectionName}": ${err.message}`);
  }
  if (!existing) {
    throw ApiError.notFound(`No index named "${name}" exists on "${collectionName}"`);
  }

  try {
    await col.dropIndex(name);
  } catch (err) {
    throw ApiError.badRequest(`MongoDB refused to drop the index: ${err.message}`);
  }

  return { name, key: existing.key, unique: !!existing.unique };
}

/**
 * The databases the session may pick from — every database on its own server,
 * minus the reserved ones and minus whatever belongs to another cluster.
 */
async function listDatabases() {
  const conn = activeDataConnection();
  const client = conn && conn.getClient ? conn.getClient() : null;
  if (!client) throw new ApiError(503, 'Database connection is not ready');

  const hidden = new Set(hiddenDatabases());
  const { databases } = await client.db().admin().listDatabases();
  return databases
    .filter((d) => !PROTECTED_DATABASES.has(d.name) && !hidden.has(d.name))
    .map((d) => ({ name: d.name, sizeOnDisk: d.sizeOnDisk ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The field names of a collection, for the index-key dropdown.
 *
 * MongoDB has no schema to read, so the names are collected from a sample of
 * documents. Nested objects are walked and reported in dotted form ("addr.city"),
 * because that is exactly what an index key looks like; arrays are reported by
 * their own name, since an index on an array field is written that way.
 *
 * A sample can only ever be a suggestion — fields absent from every sampled
 * document will not appear — so the UI must still accept a typed name.
 */
const FIELD_SAMPLE_SIZE = 200;
const FIELD_MAX_DEPTH = 4;

async function listFields(collectionName, databaseName) {
  const col = collection(collectionName, databaseName);
  const docs = await col.find({}, { limit: FIELD_SAMPLE_SIZE, projection: {} }).toArray();

  const names = new Set();
  const walk = (value, prefix, depth) => {
    if (depth > FIELD_MAX_DEPTH || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) return;
    // A BSON value (ObjectId, Date, Decimal128, Binary) is a leaf, not a shape
    // to descend into: its internal properties are not queryable fields.
    if (value._bsontype || value instanceof Date) return;
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith('$')) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      names.add(path);
      walk(child, path, depth + 1);
    }
  };
  for (const doc of docs) walk(doc, '', 1);

  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Collections in a given database. */
async function listCollections(databaseName) {
  const all = await database(databaseName).listCollections().toArray();
  return all.filter((c) => c.type !== 'view' && !c.name.startsWith('system.')).map((c) => c.name);
}

module.exports = {
  applyIndex,
  dropIndexCommand,
  createIndexCommand,
  dropIndexByName,
  listDatabases,
  listCollections,
  listFields,
  resolveDatabaseName,
  defaultDatabaseName,
  database,
  dropIndex,
  listCollectionIndexes,
  getSyncStatus,
  buildKeySpec,
  buildIndexOptions,
  describeSpec,
  assertSafeCollection,
};
