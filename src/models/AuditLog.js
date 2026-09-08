'use strict';

const mongoose = require('mongoose');
const { defineModel } = require('./registry');

// The four actions performed on a Manual Index, plus two system-level actions
// that are not about any one record:
//   PURGE — old audit entries removed by the retention policy
//   DROP  — an index removed straight from the database, without a Manual Index
const ACTIONS = ['CREATE', 'VIEW', 'UPDATE', 'DELETE', 'PURGE', 'DROP'];
const INDEX_ACTIONS = ['CREATE', 'VIEW', 'UPDATE', 'DELETE'];

const auditLogSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      enum: ACTIONS,
      index: true,
      immutable: true,
    },
    // The whole deployment shares one audit trail, so the cluster the action
    // was performed against is part of the record rather than implied by which
    // database the entry happens to sit in. Blank on entries written before
    // this was recorded, and in single-database mode.
    cluster: {
      type: String,
      trim: true,
      default: '',
      index: true,
      immutable: true,
    },
    clusterLabel: {
      type: String,
      trim: true,
      default: '',
      immutable: true,
    },
    indexId: {
      type: mongoose.Schema.Types.ObjectId,
      // Absent on PURGE, which is about the log itself, not one index.
      required() {
        return INDEX_ACTIONS.includes(this.action);
      },
      default: null,
      index: true,
      immutable: true,
    },
    indexName: {
      type: String,
      required: true,
      trim: true,
      index: true,
      immutable: true,
    },
    userId: {
      type: String,
      required: true,
      trim: true,
      index: true,
      immutable: true,
    },
    userName: {
      type: String,
      required: true,
      trim: true,
      index: true,
      immutable: true,
    },
    previousValues: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      immutable: true,
    },
    newValues: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      immutable: true,
    },
    changedFields: {
      type: [String],
      default: [],
      immutable: true,
    },

    // The mongo shell command equivalent to what the server actually ran.
    // Recorded so an entry can be read ' and reproduced ' without inferring
    // the operation from the field snapshots around it. Empty for actions
    // that touch no index in the database, such as VIEW and PURGE.
    mongoCommand: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: '',
      immutable: true,
    },
    details: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
      immutable: true,
    },
    metadata: {
      ipAddress: { type: String, default: '', immutable: true },
      userAgent: { type: String, default: '', immutable: true },
      method: { type: String, default: '', immutable: true },
      endpoint: { type: String, default: '', immutable: true },
    },
    timestamp: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
      immutable: true,
    },
  },
  {
    versionKey: false,
    timestamps: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Common query shapes: newest-first listing, and per-index history.
auditLogSchema.index({ timestamp: -1 });
auditLogSchema.index({ action: 1, timestamp: -1 });
auditLogSchema.index({ userId: 1, timestamp: -1 });
auditLogSchema.index({ indexId: 1, timestamp: -1 });
// Every cluster's entries share one collection now, so listing one cluster's
// trail newest-first is the shape this collection is read in most often.
auditLogSchema.index({ cluster: 1, timestamp: -1 });

/**
 * Hard guarantee of immutability at the data-access layer: any attempt to
 * update or delete an audit log through Mongoose is rejected, no matter which
 * part of the codebase issues it. Only `create()` is permitted.
 */
const BLOCKED_WRITE_HOOKS = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
  'findByIdAndUpdate',
  'findByIdAndDelete',
];

for (const hook of BLOCKED_WRITE_HOOKS) {
  auditLogSchema.pre(hook, function blockMutation(next) {
    next(new Error(`Audit logs are append-only: "${hook}" is not permitted`));
  });
}

auditLogSchema.pre('save', function blockResave(next) {
  if (!this.isNew) {
    return next(new Error('Audit logs are append-only: existing entries cannot be modified'));
  }
  return next();
});

auditLogSchema.statics.ACTIONS = ACTIONS;
auditLogSchema.statics.INDEX_ACTIONS = INDEX_ACTIONS;

// One audit trail for the whole deployment, on MONGODB_URI, whichever cluster
// the action was performed against — the cluster is recorded on the entry.
module.exports = defineModel('AuditLog', auditLogSchema, 'auditlogs', { central: true });
module.exports.ACTIONS = ACTIONS;
module.exports.INDEX_ACTIONS = INDEX_ACTIONS;
