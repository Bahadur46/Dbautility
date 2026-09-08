'use strict';

/**
 * Sample Manual Indexes shared by `npm run seed` and by the in-memory
 * fallback database, so a fresh start always has something to show.
 */

const ManualIndex = require('../models/ManualIndex');
const AuditLog = require('../models/AuditLog');
const auditService = require('../services/auditService');
const indexService = require('../services/indexService');

// Matches the roster in the frontend's UserContext.
const USERS = [{ userId: 'u-1001', userName: 'System Administrator' }];

const INDEXES = [
  {
    indexName: 'idx_orders_customer_created',
    description: 'Compound index supporting the customer order history screen.',
    collectionName: 'orders',
    keys: [
      { field: 'customerId', direction: 1 },
      { field: 'createdAt', direction: -1 },
    ],
    indexType: 'COMPOUND',
    status: 'ACTIVE',
  },
  {
    indexName: 'idx_users_email_unique',
    description: 'Enforces one account per email address.',
    collectionName: 'users',
    keys: [{ field: 'email', direction: 1 }],
    indexType: 'UNIQUE',
    options: { unique: true },
    status: 'ACTIVE',
  },
  {
    indexName: 'idx_products_fulltext',
    description: 'Text index powering catalogue search.',
    collectionName: 'products',
    keys: [
      { field: 'name', direction: 'text' },
      { field: 'description', direction: 'text' },
    ],
    indexType: 'TEXT',
    status: 'ACTIVE',
  },
  {
    indexName: 'idx_sessions_ttl',
    description: 'Expires stale sessions after 24 hours.',
    collectionName: 'sessions',
    keys: [{ field: 'expiresAt', direction: 1 }],
    indexType: 'TTL',
    options: { expireAfterSeconds: 86400 },
    status: 'INACTIVE',
  },
  {
    indexName: 'idx_invoices_status_partial',
    description: 'Partial index over unpaid invoices only.',
    collectionName: 'invoices',
    keys: [{ field: 'status', direction: 1 }],
    indexType: 'PARTIAL',
    options: { partialFilterExpression: { status: { $ne: 'paid' } } },
    status: 'DRAFT',
  },
];

/**
 * Load the sample records, generating real audit entries for each one.
 * `reset: true` clears both collections first (used by `npm run seed`).
 */
async function loadSampleData({ reset = false, quiet = false } = {}) {
  const log = (...args) => {
    if (!quiet) console.log(...args); // eslint-disable-line no-console
  };

  if (reset) {
    log('[seed] Clearing existing Manual Indexes and Audit Logs…');
    // Drop the real indexes these records created, so the database is left
    // as clean as the register.
    for (const stale of await ManualIndex.find({ applied: true })) {
      await indexService.dropIndex(stale).catch(() => {});
    }
    await ManualIndex.deleteMany({});
    // Bypasses the append-only guard on purpose — seeding only, never at runtime.
    await AuditLog.collection.deleteMany({});
  }

  for (let i = 0; i < INDEXES.length; i += 1) {
    const user = USERS[i % USERS.length];
    const spec = INDEXES[i];

    // ACTIVE samples get a real MongoDB index, exactly as the API would create it.
    let applied = false;
    let appliedIndexName = '';
    if (spec.status === 'ACTIVE') {
      try {
        appliedIndexName = await indexService.applyIndex(spec);
        applied = true;
      } catch (err) {
        log(`[seed] Could not apply "${spec.indexName}": ${err.message}`);
      }
    }

    const doc = await ManualIndex.create({
      ...spec,
      applied,
      appliedIndexName,
      appliedAt: applied ? new Date() : null,
      createdBy: user.userName,
      createdByUserId: user.userId,
      updatedBy: user.userName,
    });
    await auditService.logCreate({ index: doc, user });
    await auditService.logView({ index: doc, user: USERS[(i + 1) % USERS.length] });
  }

  // One realistic update so the audit log has previous/new values to show.
  const target = await ManualIndex.findOne({ indexName: 'idx_sessions_ttl' });
  if (target) {
    const previousValues = target.toAuditSnapshot();
    target.status = 'ACTIVE';
    target.description = 'Expires stale sessions after 12 hours.';
    const editor = USERS[USERS.length > 1 ? 1 : 0];
    target.updatedBy = editor.userName;
    await target.save();
    await auditService.logUpdate({
      index: target,
      user: editor,
      previousValues,
      newValues: target.toAuditSnapshot(),
    });
  }

  return {
    manualIndexes: await ManualIndex.countDocuments(),
    auditLogs: await AuditLog.countDocuments(),
  };
}

module.exports = { loadSampleData, USERS, INDEXES };
