'use strict';

const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * One row per sign-in attempt, stored in the `LoginTB` collection, beside the accounts.
 *
 * The rows share LoginTB with the accounts themselves, in the application's own
 * database — the one from the current connection string — because an attempt
 * against an unknown cluster still has to be recorded somewhere. An attempt row
 * is told apart from an account row by its `outcome` field, which only attempts
 * carry. Each row carries the cluster it
 * was made against, and the listing only ever returns the rows of the cluster
 * the reader is signed in to, so a session still sees its own cluster alone.
 *
 * Failed attempts are recorded too: an unknown username or a wrong password is
 * the thing an operator most wants to see. Nothing here ever holds the
 * password that was typed, only whether it matched.
 */

// Why an attempt ended the way it did. SUCCESS is the only outcome that opens
// a session; the rest are the ways one can be refused.
const OUTCOMES = [
  'SUCCESS',
  'INVALID_CREDENTIALS',
  'ACCOUNT_INACTIVE',
  'CLUSTER_NOT_ALLOWED',
];

const loginRecordSchema = new mongoose.Schema(
  {
    // As typed on the form, lower-cased. Kept even when no such account exists,
    // which is the point of recording failures.
    username: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
      immutable: true,
    },
    // The matched account, when there was one. Null on an unknown username.
    userId: { type: String, trim: true, default: null, index: true, immutable: true },
    userName: { type: String, trim: true, default: '', immutable: true },
    role: { type: String, trim: true, default: '', immutable: true },
    // The cluster signed in to. Empty in single-database mode.
    cluster: { type: String, trim: true, default: '', index: true, immutable: true },
    clusterLabel: { type: String, trim: true, default: '', immutable: true },
    success: { type: Boolean, required: true, index: true, immutable: true },
    outcome: {
      type: String,
      required: true,
      enum: OUTCOMES,
      index: true,
      immutable: true,
    },
    // Human-readable reason, shown in the table as-is.
    reason: { type: String, trim: true, maxlength: 200, default: '', immutable: true },
    ipAddress: { type: String, trim: true, default: '', immutable: true },
    userAgent: { type: String, trim: true, default: '', maxlength: 400, immutable: true },
    // The id of the token issued by a successful attempt (`jti`), which is how
    // a later sign-out finds the row it closes.
    sessionId: { type: String, trim: true, default: '', index: true, immutable: true },
    // When the session issued by a successful attempt expires.
    expiresAt: { type: Date, default: null, immutable: true },
    loggedOutAt: { type: Date, default: null },
    timestamp: { type: Date, default: Date.now, index: true, immutable: true },
  },
  {
    timestamps: false,
    versionKey: false,
    collection: 'LoginTB',
  }
);

// The listing is always newest-first, usually narrowed to one user or outcome.
loginRecordSchema.index({ timestamp: -1 });
loginRecordSchema.index({ username: 1, timestamp: -1 });
loginRecordSchema.index({ success: 1, timestamp: -1 });

loginRecordSchema.statics.OUTCOMES = OUTCOMES;

// Sign-in history belongs beside the accounts, in the cluster's own database.
const LoginRecord = defineModel('LoginRecord', loginRecordSchema, 'LoginTB');

module.exports = LoginRecord;
module.exports.OUTCOMES = OUTCOMES;
