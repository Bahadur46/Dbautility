'use strict';

const ApiError = require('../utils/ApiError');
const indexService = require('./indexService');
const auditService = require('./auditService');
const optimizationService = require('./optimizationService');
const { activeCluster } = require('../config/clusterConnections');

/**
 * Run a mongo shell command pasted straight from a portal or a colleague.
 *
 * The point is fidelity of the record: an index dropped by hand in Compass or
 * mongosh leaves no trace anywhere, which is exactly the gap this application
 * exists to close. Pasting the same line here does the same thing AND writes
 * the audit entry, so the trail matches the database.
 *
 * It is deliberately NOT a general shell. Only index operations are accepted,
 * and only the two that make sense to run from a console someone pastes into:
 *
 *   dropIndex("name")   — removes an index, recorded as a DROP entry
 *   getIndexes()        — reads them back, changes nothing, not recorded
 *
 * Anything else is refused by name rather than ignored, so a paste that would
 * have deleted documents fails loudly instead of appearing to succeed. There is
 * no eval() anywhere in here: the command is parsed, and the parsed pieces are
 * passed to the driver as data. A command that does not match the grammar below
 * is rejected, never executed as text.
 */

// The operations the executor will run at all.
const SUPPORTED = ['dropIndex', 'getIndexes', 'listIndexes'];

// Operations worth naming in the refusal, because someone will paste them and
// deserves to know why this console will not run them rather than "invalid".
const REFUSED = {
  drop: 'dropping a whole collection',
  dropDatabase: 'dropping a database',
  deleteOne: 'deleting documents',
  deleteMany: 'deleting documents',
  remove: 'deleting documents',
  insertOne: 'inserting documents',
  insertMany: 'inserting documents',
  updateOne: 'updating documents',
  updateMany: 'updating documents',
  replaceOne: 'replacing documents',
  find: 'reading documents',
  findOne: 'reading documents',
  aggregate: 'running an aggregation',
  createIndex: 'creating an index',
  createIndexes: 'creating an index',
  renameCollection: 'renaming a collection',
  eval: 'evaluating arbitrary code',
};

/**
 * The pieces of a shell command: which database, which collection, which
 * operation, and its argument.
 *
 * Accepts the two forms people actually paste —
 *
 *   db.getSiblingDB("ERP_40019").getCollection("Admin_Columns").dropIndex("ix")
 *   db.Admin_Columns.dropIndex("ix")
 *
 * — with an optional trailing semicolon, and whitespace or newlines anywhere
 * between the parts, because a copied line rarely arrives tidy.
 */
const COMMAND = new RegExp(
  '^\\s*db\\s*' +
    // .getSiblingDB("name") — optional; without it the session's own target
    // database is used.
    '(?:\\.\\s*getSiblingDB\\s*\\(\\s*["\']([^"\']+)["\']\\s*\\)\\s*)?' +
    // .getCollection("name") or .name
    '(?:\\.\\s*getCollection\\s*\\(\\s*["\']([^"\']+)["\']\\s*\\)|\\.\\s*([A-Za-z_][\\w.-]*))\\s*' +
    // .operation( ... )
    '\\.\\s*([A-Za-z_]\\w*)\\s*\\(([\\s\\S]*)\\)\\s*;?\\s*$'
);

/** Split the command text into its parts, or explain why it cannot be read. */
function parseCommand(text) {
  const raw = String(text || '').trim();
  if (!raw) throw ApiError.badRequest('Enter a command to run');

  // A paste with several statements is refused whole: running the first and
  // silently dropping the rest is the worst of both outcomes.
  if (/;\s*\S/.test(raw.replace(/;\s*$/, ''))) {
    throw ApiError.badRequest(
      'Run one command at a time — this looks like several statements separated by ";"'
    );
  }

  const match = COMMAND.exec(raw);
  if (!match) {
    throw ApiError.badRequest(
      'This does not look like a mongo shell index command. Expected something like: ' +
        'db.getSiblingDB("myDb").getCollection("myCollection").dropIndex("myIndex")'
    );
  }

  const [, siblingDb, quotedCollection, dottedCollection, operation, argText] = match;

  if (!SUPPORTED.includes(operation)) {
    const why = REFUSED[operation];
    throw ApiError.badRequest(
      why
        ? `This console does not run ${why}. It runs index operations only: ${SUPPORTED.join('(), ')}().`
        : `"${operation}()" is not supported here. This console runs index operations only: ${SUPPORTED.join('(), ')}().`
    );
  }

  return {
    databaseName: (siblingDb || '').trim(),
    collectionName: (quotedCollection || dottedCollection || '').trim(),
    operation,
    argText: String(argText || '').trim(),
  };
}

/** The single string argument of dropIndex("name"), or ''. */
function parseIndexNameArg(argText) {
  const match = /^["']([^"']+)["']$/.exec(argText);
  if (!match) {
    throw ApiError.badRequest(
      'dropIndex needs the index name in quotes, for example: dropIndex("AddEditSequence_1_AddType_1"). ' +
        'Dropping by key pattern is not supported here — read the name with getIndexes() first.'
    );
  }
  return match[1];
}

/**
 * Execute one command.
 *
 * A drop is audited before the response is sent, so an index can never be
 * removed through this console without the entry that records it.
 */
async function execute({ command, reason, user, req }) {
  const parsed = parseCommand(command);
  // Resolves the target the same way every other write does, so the executor
  // inherits the reserved-database and other-cluster refusals rather than
  // reimplementing them.
  const databaseName = indexService.resolveDatabaseName(parsed.databaseName);
  const collectionName = indexService.assertSafeCollection(parsed.collectionName);
  const cluster = activeCluster();

  const db = indexService.database(parsed.databaseName);

  // Both operations need the current index list: one to return it, the other
  // to record what was actually removed and to fail cleanly when it is absent.
  let indexes;
  try {
    indexes = await db.collection(collectionName).listIndexes().toArray();
  } catch (err) {
    if (err.code === 26 || /ns does not exist|ns not found/i.test(err.message)) {
      throw ApiError.notFound(
        `"${databaseName}.${collectionName}" does not exist on ${cluster ? cluster.label : 'this'}'s server`
      );
    }
    throw ApiError.badRequest(`Could not read indexes from "${collectionName}": ${err.message}`);
  }

  if (parsed.operation !== 'dropIndex') {
    return {
      operation: parsed.operation,
      databaseName,
      collectionName,
      changed: false,
      audited: false,
      indexes: indexes.map((i) => ({ name: i.name, key: i.key, unique: !!i.unique })),
      message: `${indexes.length} index${indexes.length === 1 ? '' : 'es'} on ${databaseName}.${collectionName}`,
    };
  }

  const indexName = parseIndexNameArg(parsed.argText);
  const existing = indexes.find((i) => i.name === indexName);
  if (!existing) {
    throw ApiError.notFound(
      `No index named "${indexName}" exists on "${databaseName}.${collectionName}". ` +
        `Present: ${indexes.map((i) => i.name).join(', ')}`
    );
  }

  // Same guard as every other drop path: MongoDB's own primary key index is
  // never removable, whatever the paste says.
  await indexService.dropIndexByName({ databaseName: parsed.databaseName, collectionName, indexName });

  // Is this one of ours? Read after the drop but before the audit entry, so a
  // failed drop cannot deactivate a record for an index that is still there.
  //
  // Without this the register and the database drift apart in the worst
  // direction: the record goes on claiming applied: true with an
  // appliedIndexName that no longer exists, Sync reports drift nobody caused,
  // and the definition that would rebuild the index looks live when it is not.
  const ManualIndex = require('../models/ManualIndex');
  const owner = await ManualIndex.findOne({
    collectionName,
    appliedIndexName: indexName,
    $or: [{ databaseName }, { databaseName: '' }],
  });

  if (owner) {
    // The definition survives — it is what makes the drop reversible — but it
    // stops asserting an index that is deliberately gone.
    owner.applied = false;
    owner.appliedIndexName = '';
    owner.appliedAt = null;
    owner.status = 'INACTIVE';
    owner.lastSyncError = '';
    owner.updatedBy = user.userName;
    await owner.save();
  }

  const auditEntry = await auditService.logIndexDrop({
    databaseName,
    collectionName,
    indexName,
    key: existing.key,
    user,
    req,
    // The command as typed, not a rebuilt one: the entry should show exactly
    // what was pasted and run.
    mongoCommand: String(command).trim(),
    // Why it was dropped, when whoever dropped it said so. Kept first: read
    // back months later, the reason is the part nobody can reconstruct, while
    // the rest of the sentence is derivable from the entry's own fields.
    details: [
      reason && String(reason).trim() ? `Reason: ${String(reason).trim()}` : '',
      `Index "${indexName}" was dropped from ${databaseName}.${collectionName} by ${user.userName}`,
      owner ? `Manual Index "${owner.indexName}" was kept and set to INACTIVE` : '',
    ]
      .filter(Boolean)
      .join(' — ')
      .slice(0, 500),
  });

  // A drop typed by hand is still a drop: the dashboard counts the change made
  // to the database, not the screen it was requested from.
  await optimizationService.recordIndexDropped({
    databaseName,
    collectionName,
    indexName,
    key: existing.key,
    user,
    auditLog: auditEntry,
    manualIndexId: owner ? owner._id : null,
    notes: reason && String(reason).trim() ? String(reason).trim() : 'Dropped from the Query Executor',
  });

  return {
    operation: 'dropIndex',
    databaseName,
    collectionName,
    indexName,
    key: existing.key,
    changed: true,
    audited: true,
    message: `Index "${indexName}" was dropped from ${databaseName}.${collectionName}. A DROP audit entry was recorded.`,
  };
}

module.exports = { execute, parseCommand, SUPPORTED };
