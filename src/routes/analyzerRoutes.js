'use strict';

const express = require('express');
const controller = require('../controllers/analyzerController');

const router = express.Router();

// Read-only diagnostics. Creating an index from a recommendation goes through
// POST /api/manual-indexes, so it is audited like any other index change.
router.get('/overview', controller.getOverview);
router.get('/index-usage', controller.getIndexUsage);
router.get('/slow-queries', controller.getSlowQueries);
router.route('/profiler').get(controller.getProfiler).put(controller.setProfiler);
router.post('/analyze', controller.analyzeQuery);

// The one write the analyzer performs: dropping an index it flagged as unused.
// Admin only, and recorded as a DROP entry in the audit log.
router.delete('/indexes', controller.dropIndex);

// The same drop, asked for as a pasted mongo shell line rather than a button.
router.post('/execute', controller.executeCommand);

module.exports = router;
