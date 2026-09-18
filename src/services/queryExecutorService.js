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
 * and only the ones that make sense to run from a console someone pastes into:
 *
 *   createIndex({...})  — creates an index, recorded as a CREATE entry
 *   dropIndex("name")   — removes an index, recorded as a DROP entry
 *   getIndexes()        — reads them back, changes nothing, not recorded
 *
 * createIndex is here for the same reason dropIndex is: an index built by hand
 * in Compass or mongosh leaves no trace, and the gap this application exists to
 * close is the same in both directions. The arguments are parsed into data and
 * handed to the driver — the text is never evaluated.
 *
 * Anything else is refused by name rather than ignored, so a paste that would
 * have deleted documents fails loudly instead of appearing to succeed. There is
 * no eval() anywhere in here: the command is parsed, and the parsed pieces are
 * passed to the driver as data. A command that does not match the grammar below
 * is rejected, never executed as text.
 */

// The operations the executor will run at all.
const SUPPORTED = ['createIndex', 'dropIndex', 'getIndexes', 'listIndexes'];

// The operations that change the database, so they are audited and counted.
const WRITES = ['createIndex', 'dropIndex'];

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
  // Several indexes in one array argument. Refused on purpose: a paste that
  // half-succeeds would leave the audit trail describing work that did not all
  // happen, and one index per command keeps each entry answerable on its own.
  createIndexes: 'creating several indexes at once — run one createIndex() per index',
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
 * Rewrite a shell object literal as strict JSON, then parse it.
 *
 * Shell notation is JSON with the corners knocked off: keys can be unquoted,
 * strings can use single quotes, and a trailing comma is forgiven. This walks
 * the text once, tracking whether it is inside a string, so a brace or a colon
 * that happens to sit inside a value is left alone. Nothing is evaluated — the
 * result is plain data handed to the driver.
 */
function toJsonLiteral(text) {
  const raw = String(text || '');
  let out = '';
  let quote = '';

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (quote) {
      if (ch === '\\') {
        out += ch + (raw[i + 1] || '');
        i += 1;
      } else if (ch === quote) {
        quote = '';
        out += '"';
      } else {
        // A double quote inside a single-quoted string has to be escaped once
        // the string becomes double-quoted.
        out += ch === '"' ? '\\"' : ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      out += '"';
      continue;
    }

    // An unquoted key: an identifier sitting immediately before a colon.
    if (/[A-Za-z_$]/.test(ch)) {
      const rest = raw.slice(i);
      const ident = /^[A-Za-z_$][\w$.]*/.exec(rest)[0];
      const after = rest.slice(ident.length);
      if (/^\s*:/.test(after)) {
        out += `"${ident}"`;
        i += ident.length - 1;
        continue;
      }
      // Not a key — a bare word like `true` or `null` passes through and is
      // JSON.parse's problem if it is neither.
      out += ident;
      i += ident.length - 1;
      continue;
    }

    out += ch;
  }

  if (quote) throw ApiError.badRequest('This command has an unclosed quote');

  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Parse one shell object literal, naming what it was in any failure. */
function parseObjectArg(text, label) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('{')) {
    throw ApiError.badRequest(`The ${label} of createIndex() must be an object, for example { "field": 1 }`);
  }

  let value;
  try {
    value = JSON.parse(toJsonLiteral(raw));
  } catch (err) {
    throw ApiError.badRequest(`Could not read the ${label} of this createIndex(): ${err.message}`);
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest(`The ${label} of createIndex() must be an object, for example { "field": 1 }`);
  }
  return value;
}

/**
 * Split the text between the outermost brackets of a call into its arguments.
 * Commas inside nested objects, arrays or strings are not separators.
 */
function splitArgs(argText) {
  const raw = String(argText || '').trim();
  if (!raw) return [];

  const parts = [];
  let depth = 0;
  let quote = '';
  let current = '';

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (quote) {
      current += ch;
      if (ch === '\\') {
        current += raw[i + 1] || '';
        i += 1;
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    if (ch === '}' || ch === ']') depth -= 1;

    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }

  parts.push(current.trim());
  return parts.filter((p) => p !== '');
}

// Directions a key may carry, matching what indexService builds for a Manual
// Index — anything else is a typo or an index type this application does not
// manage, and either way it should not reach the driver.
const KEY_DIRECTIONS = new Set(['text', 'hashed', '2dsphere', '2d']);

// Options this console will pass on. A whitelist rather than a pass-through:
// an option nobody here understands should be refused by name, not forwarded
// and discovered later in a failure nobody can read.
const ALLOWED_OPTIONS = new Set([
  'name',
  'unique',
  'sparse',
  'expireAfterSeconds',
  'partialFilterExpression',
  'background',
  'collation',
]);

/** The key specification and options of createIndex({...}, {...}). */
function parseCreateIndexArgs(argText) {
  const args = splitArgs(argText);
  if (args.length === 0) {
    throw ApiError.badRequest(
      'createIndex needs the keys, for example: createIndex({ "RefID": 1, "SubscriberID": 1 }, { "name": "RefID_1_SubscriberID_1" })'
    );
  }
  if (args.length > 2) {
    throw ApiError.badRequest('createIndex takes the keys and, optionally, the options — nothing more');
  }

  const keys = parseObjectArg(args[0], 'key specification');
  const fields = Object.keys(keys);
  if (fields.length === 0) {
    throw ApiError.badRequest('Cannot create an index without at least one key field');
  }

  for (const field of fields) {
    const direction = keys[field];
    if (typeof direction === 'string') {
      if (!KEY_DIRECTIONS.has(direction)) {
        throw ApiError.badRequest(
          `"${field}": "${direction}" is not an index direction. Use 1, -1, or one of ${[...KEY_DIRECTIONS].join(', ')}.`
        );
      }
      continue;
    }
    if (direction !== 1 && direction !== -1) {
      throw ApiError.badRequest(`"${field}" must be 1 or -1, not ${JSON.stringify(direction)}`);
    }
  }

  const options = args.length === 2 ? parseObjectArg(args[1], 'options') : {};
  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTIONS.has(key)) {
      throw ApiError.badRequest(
        `"${key}" is not an index option this console will pass on. Supported: ${[...ALLOWED_OPTIONS].join(', ')}.`
      );
    }
  }
  if (options.name !== undefined && (typeof options.name !== 'string' || !options.name.trim())) {
    throw ApiError.badRequest('The index "name" option must be a non-empty string');
  }

  return { keys, options };
}

/** The name MongoDB gives an index when the command does not name one. */
function defaultIndexName(keys) {
  return Object.entries(keys)
    .map(([field, direction]) => `${field}_${direction}`)
    .join('_');
}

/**
 * The index type the dashboard should file this index under.
 *
 * The shell command does not say — it describes the index, not our taxonomy —
 * so it is read back off the specification, in the order that answers "what is
 * this index FOR": a uniqueness constraint first, then a TTL, then a filtered
 * index, then the special key directions, and only then its shape.
 */
function classify(keys, options) {
  if (options.unique) return 'UNIQUE';
  if (options.expireAfterSeconds !== undefined) return 'TTL';
  if (options.partialFilterExpression) return 'PARTIAL';

  const directions = Object.values(keys);
  if (directions.includes('text')) return 'TEXT';
  if (directions.includes('hashed')) return 'HASHED';
  if (directions.includes('2dsphere')) return 'GEO2DSPHERE';
  if (directions.includes('2d')) return 'GEO2D';
  if (Object.keys(keys).some((f) => f.includes('$**'))) return 'WILDCARD';

  return Object.keys(keys).length > 1 ? 'COMPOUND' : 'SINGLE';
}

/**
 * Run a pasted createIndex() — the counterpart of the drop path below, and
 * audited on the same terms: the index exists first, then the entry that
 * records it, then the dashboard row that counts it.
 */
async function createFromCommand({
  command,
  parsed,
  reason,
  user,
  req,
  db,
  databaseName,
  collectionName,
  indexes,
}) {
  const { keys, options } = parseCreateIndexArgs(parsed.argText);
  const indexName = (options.name || '').trim() || defaultIndexName(keys);

  // Refused here rather than left to the driver: MongoDB answers a repeated
  // identical createIndex with success and no change, which would put a CREATE
  // entry in the trail for work that did not happen.
  if (indexes.some((i) => i.name === indexName)) {
    throw ApiError.conflict(
      `An index named "${indexName}" already exists on "${databaseName}.${collectionName}". ` +
        'Drop it first, or name this one differently.'
    );
  }

  let createdName;
  try {
    createdName = await db.collection(collectionName).createIndex(keys, { ...options, name: indexName });
  } catch (err) {
    if (err.codeName === 'IndexOptionsConflict' || err.code === 85) {
      throw ApiError.conflict(
        `An index named "${indexName}" already exists on "${databaseName}.${collectionName}" with a different definition.`
      );
    }
    if (err.codeName === 'IndexKeySpecsConflict' || err.code === 86) {
      throw ApiError.conflict(
        `An index with these keys already exists on "${collectionName}" under a different name.`
      );
    }
    throw ApiError.badRequest(`MongoDB rejected the index: ${err.message}`);
  }

  // Is this one of ours? A definition kept as INACTIVE after its index was
  // dropped is rebuilt by this command as surely as by the Sync button, and
  // leaving it INACTIVE would report drift nobody caused — the mirror image of
  // the ownership check the drop path makes below.
  const ManualIndex = require('../models/ManualIndex');
  const owner = await ManualIndex.findOne({
    collectionName,
    indexName: createdName,
    $or: [{ databaseName }, { databaseName: '' }],
  });

  if (owner) {
    owner.applied = true;
    owner.appliedIndexName = createdName;
    owner.appliedAt = new Date();
    owner.status = 'ACTIVE';
    owner.lastSyncError = '';
    owner.updatedBy = user.userName;
    await owner.save();
  }

  const keyList = Object.entries(keys).map(([field, direction]) => ({ field, direction: String(direction) }));
  const indexType = classify(keys, options);

  const auditEntry = await auditService.record({
    action: 'CREATE',
    index: { _id: owner ? owner._id : null, indexName: createdName },
    user,
    req,
    newValues: { databaseName, collectionName, indexName: createdName, keys: keyList, indexType, options },
    // The command as typed, not a rebuilt one: the entry should show exactly
    // what was pasted and run.
    mongoCommand: String(command).trim(),
    details: [
      reason && String(reason).trim() ? `Reason: ${String(reason).trim()}` : '',
      `Index "${createdName}" was created on ${databaseName}.${collectionName} by ${user.userName}`,
      owner ? `Manual Index "${owner.indexName}" was marked ACTIVE` : '',
    ]
      .filter(Boolean)
      .join(' — ')
      .slice(0, 500),
  });

  // An index typed by hand is still an index: the dashboard counts the change
  // made to the database, not the screen it was requested from.
  await optimizationService.recordIndexCreated({
    index: {
      _id: owner ? owner._id : null,
      databaseName,
      collectionName,
      indexName: createdName,
      appliedIndexName: createdName,
      indexType,
      keys: keyList,
      options,
    },
    user,
    auditLog: auditEntry,
    databaseName,
    notes: reason && String(reason).trim() ? String(reason).trim() : 'Created from the Query Executor',
  });

  return {
    operation: 'createIndex',
    databaseName,
    collectionName,
    indexName: createdName,
    key: keys,
    changed: true,
    audited: true,
    message: `Index "${createdName}" was created on ${databaseName}.${collectionName}. A CREATE audit entry was recorded.`,
  };
}

/**
 * Execute one command.
 *
 * A write is audited before the response is sent, so an index can never be
 * created or removed through this console without the entry that records it.
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

  // Every operation needs the current index list: to return it, to record what
  // was actually removed, or to refuse a create whose name is already taken.
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

  if (parsed.operation === 'createIndex') {
    return createFromCommand({
      command,
      parsed,
      reason,
      user,
      req,
      db,
      databaseName,
      collectionName,
      indexes,
    });
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

module.exports = { execute, parseCommand, parseCreateIndexArgs, SUPPORTED, WRITES };
