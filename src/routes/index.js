'use strict';

const express = require('express');
const authRoutes = require('./authRoutes');
const manualIndexRoutes = require('./manualIndexRoutes');
const auditLogRoutes = require('./auditLogRoutes');
const analyzerRoutes = require('./analyzerRoutes');
const queryExecutorRoutes = require('./queryExecutorRoutes');
const { getDbMode, getDbError } = require('../config/db');
const clusters = require('../config/clusters');
const { requireCluster } = require('../middleware/auth');
const requireDatabase = require('../middleware/requireDatabase');

const router = express.Router();

// Health answers from the moment the port is bound, including while the
// database is still coming up or has failed — that is exactly when someone
// needs it to say so. `success` reports whether the API can actually serve
// data, so a monitor sees the difference; the endpoint itself stays 200 so it
// is never mistaken for the platform's own error page.
router.get('/health', (req, res) => {
  const database = getDbMode();
  const ready = database === 'mongodb' || database === 'in-memory';
  res.json({
    success: ready,
    message: ready
      ? 'DBA Utility API is healthy'
      : database === 'connecting'
        ? 'DBA Utility API is starting — connecting to the database'
        : 'DBA Utility API is running but cannot reach its database',
    // 'mongodb' = the configured database; 'in-memory' = temporary fallback;
    // 'connecting' = still starting; 'unavailable' = neither could be reached.
    database,
    databaseError: getDbError() || undefined,
    // The clusters this deployment serves; empty when it runs single-database.
    clusters: clusters.listPublic(),
    timestamp: new Date().toISOString(),
  });
});

// Signing in reads the accounts out of the database, so it needs one too.
router.use('/auth', requireDatabase, authRoutes);
// Everything below reads or writes cluster data, so it needs a database and
// must be served from exactly one cluster.
router.use('/manual-indexes', requireDatabase, requireCluster, manualIndexRoutes);
router.use('/audit-logs', requireDatabase, requireCluster, auditLogRoutes);
router.use('/analyzer', requireDatabase, requireCluster, analyzerRoutes);
router.use('/query-executor', requireDatabase, requireCluster, queryExecutorRoutes);

module.exports = router;
