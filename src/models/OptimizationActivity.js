'use strict';

const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * One DBA optimisation, recorded so the dashboard can report what was done and
 * what it bought.
 *
 * This is deliberately a separate collection from the audit trail rather than a
 * view over it. The audit log answers "who changed which record, and what did
 * the fields look like before and after" — it is evidence, append-only, and
 * knows nothing about execution times. The dashboard asks a different question:
 * "how much faster is the database because of the work we did". A slow query
 * rewritten in application code changes no Manual Index record at all and so
 * leaves no audit entry, yet it is exactly the kind of work this collection
 * exists to count. Entries here reference the audit entry when there is one.
 */

// The four activity types the dashboard breaks down by.
const ACTIVITY_TYPES = ['LONG_QUERY', 'INDEX_CREATED', 'INDEX_DROPPED', 'API_OPTIMIZATION'];

/**
 * Where a piece of work has got to.
 *
 * IN_PROGRESS and TO_BE_TESTED are the board an API optimisation moves along;
 * both mean "not live yet", and neither is averaged into the performance panel
 * — only APPLIED work has actually changed how anything behaves. APPLIED is
 * what the API board calls "Done": the same fact, said the way each screen says
 * it, rather than a second field that could disagree with this one.
 *
 * PENDING stays for the work recorded before this board existed, and for a long
 * query that is simply found and not yet picked up.
 */
const STATUSES = ['APPLIED', 'PENDING', 'IN_PROGRESS', 'TO_BE_TESTED', 'REVERTED', 'FAILED'];

/**
 * A performance measurement, taken before or after the change.
 *
 * Every field is optional and defaults to null rather than 0. An optimisation
 * nobody measured must not report "0 ms" — that reads as instantaneous, and it
 * would drag every average on the dashboard towards zero. Null means unknown,
 * and the aggregations skip it.
 */
const measurementSchema = new mongoose.Schema(
  {
    executionTimeMs: { type: Number, default: null, min: 0 },
    documentsExamined: { type: Number, default: null, min: 0 },
    documentsReturned: { type: Number, default: null, min: 0 },
    keysExamined: { type: Number, default: null, min: 0 },
    // COLLSCAN / IXSCAN / FETCH … — whatever the plan reported.
    planStage: { type: String, trim: true, default: '' },
    indexUsed: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const optimizationActivitySchema = new mongoose.Schema(
  {
    activityType: {
      type: String,
      required: true,
      enum: ACTIVITY_TYPES,
      index: true,
    },

    // Same reasoning as the audit trail: one collection serves the whole
    // deployment, so the cluster an activity happened on is a field on the
    // entry, and every dashboard read is scoped by it.
    cluster: { type: String, trim: true, default: '', index: true },
    clusterLabel: { type: String, trim: true, default: '' },

    databaseName: { type: String, trim: true, default: '', index: true },
    collectionName: { type: String, trim: true, default: '', index: true },

    // What was optimised, in one line, for the "Query / Index" column:
    // an index name, a query shape, or an API route.
    subject: { type: String, required: true, trim: true, maxlength: 500 },
    // The full thing behind that one line — the query document, the index key
    // spec, the request payload. Shown when a row is expanded.
    subjectDetail: { type: mongoose.Schema.Types.Mixed, default: null },

    before: { type: measurementSchema, default: () => ({}) },
    after: { type: measurementSchema, default: () => ({}) },

    /**
     * Percentage the execution time fell by. Derived from before/after on save
     * — never accepted from the caller, so the dashboard's headline number
     * cannot disagree with the measurements printed next to it. Null when
     * either side is unmeasured. Negative when the change made things slower,
     * which is worth seeing rather than clamping away.
     */
    improvementPercent: { type: Number, default: null },

    status: { type: String, enum: STATUSES, default: 'APPLIED', index: true },

    /**
     * Who the work was for.
     *
     * A deployment serves several clients from one cluster, so "which endpoint"
     * is only half of "whose endpoint" — and a board that cannot be read per
     * client cannot be handed to the person who owns that client.
     */
    clientName: { type: String, trim: true, default: '', maxlength: 200, index: true },

    userId: { type: String, required: true, trim: true, index: true },
    userName: { type: String, required: true, trim: true },

    // The audit entry this activity came from, when it came from one. Index
    // creates and drops have one; a query rewrite or an API change does not.
    auditLogId: { type: mongoose.Schema.Types.ObjectId, default: null },
    manualIndexId: { type: mongoose.Schema.Types.ObjectId, default: null },

    notes: { type: String, trim: true, maxlength: 1000, default: '' },

    timestamp: { type: Date, required: true, default: Date.now, index: true },
  },
  {
    versionKey: false,
    timestamps: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

/**
 * Keep the derived number in step with its inputs on every write path —
 * `create`, `save`, and the `insertMany` the future may bring.
 */
function computeImprovement(doc) {
  const before = doc.before && doc.before.executionTimeMs;
  const after = doc.after && doc.after.executionTimeMs;
  if (typeof before !== 'number' || typeof after !== 'number' || before <= 0) {
    doc.improvementPercent = null;
    return;
  }
  doc.improvementPercent = Math.round(((before - after) / before) * 10000) / 100;
}

optimizationActivitySchema.pre('validate', function setImprovement(next) {
  computeImprovement(this);
  next();
});

// The dashboard reads this collection in exactly three shapes: a date range on
// one cluster (every card and chart), that range narrowed to one type (the
// card click-through), and the newest N (the recent-activity table).
optimizationActivitySchema.index({ cluster: 1, timestamp: -1 });
optimizationActivitySchema.index({ cluster: 1, activityType: 1, timestamp: -1 });
optimizationActivitySchema.index({ timestamp: -1 });

optimizationActivitySchema.statics.ACTIVITY_TYPES = ACTIVITY_TYPES;
optimizationActivitySchema.statics.STATUSES = STATUSES;

// Central, beside the audit trail it mirrors: one dashboard for the
// deployment, with the cluster recorded on each entry.
module.exports = defineModel(
  'OptimizationActivity',
  optimizationActivitySchema,
  'optimizationactivities',
  { central: true }
);
module.exports.ACTIVITY_TYPES = ACTIVITY_TYPES;
module.exports.STATUSES = STATUSES;
