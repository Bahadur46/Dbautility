'use strict';

const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/** One field of the index key, e.g. { field: 'createdAt', direction: -1 }. */
const indexKeySchema = new mongoose.Schema(
  {
    field: {
      type: String,
      required: [true, 'Key field name is required'],
      trim: true,
      maxlength: [120, 'Field name must be at most 120 characters'],
    },
    direction: {
      // 1 / -1 order the key; 'text', 'hashed', '2dsphere' and '2d' select a
      // specialised index implementation for that field.
      type: mongoose.Schema.Types.Mixed,
      default: 1,
    },
  },
  { _id: false }
);

const manualIndexSchema = new mongoose.Schema(
  {
    indexName: {
      type: String,
      required: [true, 'Index name is required'],
      trim: true,
      minlength: [3, 'Index name must be at least 3 characters'],
      maxlength: [120, 'Index name must be at most 120 characters'],
      unique: true,
      index: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: [1000, 'Description must be at most 1000 characters'],
      default: '',
    },
    // The database the index is created on. Blank means the configured
    // default (TARGET_DB, or the database in the connection string).
    databaseName: {
      type: String,
      trim: true,
      default: '',
      maxlength: [80, 'Database name must be at most 80 characters'],
    },
    collectionName: {
      type: String,
      required: [true, 'Collection name is required'],
      trim: true,
      maxlength: [120, 'Collection name must be at most 120 characters'],
    },
    // The key specification actually sent to createIndex().
    keys: {
      type: [indexKeySchema],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: 'At least one index key is required',
      },
    },
    indexType: {
      type: String,
      enum: {
        values: [
          'SINGLE', 'COMPOUND', 'UNIQUE', 'PARTIAL', 'TTL',
          'TEXT', 'HASHED', 'WILDCARD', 'GEO2DSPHERE', 'GEO2D',
        ],
        message: '{VALUE} is not a supported index type',
      },
      default: 'SINGLE',
    },
    options: {
      unique: { type: Boolean, default: false },
      sparse: { type: Boolean, default: false },
      background: { type: Boolean, default: true },
      // TTL indexes only
      expireAfterSeconds: { type: Number, default: null },
      // Optional on ANY index type — MongoDB treats a partial condition as an
      // index option, not a kind of index.
      partialFilterExpression: { type: mongoose.Schema.Types.Mixed, default: null },
    },
    status: {
      type: String,
      enum: {
        values: ['ACTIVE', 'INACTIVE', 'DRAFT'],
        message: '{VALUE} is not a supported status',
      },
      default: 'ACTIVE',
      index: true,
    },

    // ---- Live database state -------------------------------------------
    // ACTIVE records have a real index in MongoDB; DRAFT and INACTIVE ones
    // are definitions only. These fields record what was actually applied.
    applied: { type: Boolean, default: false },
    appliedIndexName: { type: String, default: '', trim: true },
    appliedAt: { type: Date, default: null },
    lastSyncError: { type: String, default: '' },

    createdBy: {
      type: String,
      required: [true, 'createdBy is required'],
      trim: true,
    },
    createdByUserId: {
      type: String,
      required: true,
      trim: true,
    },
    updatedBy: {
      type: String,
      trim: true,
      default: '',
    },
  },
  {
    timestamps: true, // createdAt / updatedAt
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

manualIndexSchema.index({ databaseName: 1, collectionName: 1 });

/** Fields compared when building CREATE / UPDATE / DELETE audit snapshots. */
const AUDITABLE_FIELDS = [
  'indexName',
  'description',
  'databaseName',
  'collectionName',
  'keys',
  'indexType',
  'options',
  'status',
];

manualIndexSchema.statics.AUDITABLE_FIELDS = AUDITABLE_FIELDS;

/** Human-readable key spec, e.g. "customerId: 1, createdAt: -1". */
manualIndexSchema.virtual('keySignature').get(function keySignature() {
  return (this.keys || []).map((k) => `${k.field}: ${k.direction}`).join(', ');
});

/** Plain snapshot of the auditable fields — used for previousValues / newValues. */
manualIndexSchema.methods.toAuditSnapshot = function toAuditSnapshot() {
  const snapshot = {};
  for (const field of AUDITABLE_FIELDS) {
    const value = this[field];
    if (field === 'keys') {
      snapshot.keys = (value || []).map((k) => ({ field: k.field, direction: k.direction }));
    } else if (field === 'options') {
      const o = value || {};
      snapshot.options = {
        unique: !!o.unique,
        sparse: !!o.sparse,
        expireAfterSeconds: o.expireAfterSeconds ?? null,
        partialFilterExpression: o.partialFilterExpression ?? null,
      };
    } else {
      snapshot[field] = value;
    }
  }
  return snapshot;
};

module.exports = defineModel('ManualIndex', manualIndexSchema, 'manualindexes');
module.exports.AUDITABLE_FIELDS = AUDITABLE_FIELDS;
