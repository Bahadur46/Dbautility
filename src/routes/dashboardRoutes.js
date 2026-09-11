'use strict';

const express = require('express');
const controller = require('../controllers/dashboardController');
const longQuery = require('../controllers/longQueryController');

const router = express.Router();

/**
 * The DBA Optimization Dashboard, mounted at /api/dashboard/dba.
 *
 * Read-only apart from one write. Every read takes `?from=` and `?to=` as ISO
 * instants (either may be omitted — "all time" has neither) and `?cluster=`,
 * which defaults to every cluster.
 *
 * The `/dba` segment is the contract the frontend already calls. Serving these
 * paths is what stops it falling back to its generated sample dataset.
 */
router.get('/summary', controller.getSummary);
router.get('/range-counts', controller.getRangeCounts);
router.get('/cluster-counts', controller.getClusterCounts);
router.get('/filters/options', controller.getFilterOptions);

// The table, the drill-down a KPI card opens (?activityType=), and the write
// that records the optimisations the server cannot observe for itself — query
// rewrites and API work. See the controller for why index changes are rejected.
router.route('/activities').get(controller.getActivities).post(controller.createActivity);

// Long queries: diagnose one, put it on the board, close it once it is fixed.
// `analyze` writes nothing, so it can be run against anything without leaving
// a trail of half-finished work. Declared before /:id so neither swallows it.
router.post('/long-queries/analyze', longQuery.analyzeLongQuery);
router.post('/long-queries/:id/resolve', longQuery.resolveLongQuery);
router.post('/long-queries', longQuery.recordLongQuery);

// API optimisations: the same board, measured from outside the database. There
// is no operation document to analyse — an API call is timed by the caller, not
// described by MongoDB — so this records the route and its cost directly.
router.post('/api-optimizations', longQuery.recordApiOptimization);

// Closing is the same question whichever kind of work was done, so both kinds
// resolve through one path. The /long-queries spelling stays because it is
// already in use; neither is a different operation.
router.post('/optimizations/:id/resolve', longQuery.resolveLongQuery);

// Where the work has got to, as opposed to what it bought. No measurement is
// involved, so this is not the same operation as resolving.
router.post('/optimizations/:id/status', longQuery.setStatus);

// Correcting the board. Only the hand-entered kinds can be removed — see the
// controller for why an index row cannot.
router.delete('/optimizations/:id', longQuery.deleteOptimization);

module.exports = router;
