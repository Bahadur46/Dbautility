'use strict';

const express = require('express');
const authRoutes = require('./authRoutes');
const manualIndexRoutes = require('./manualIndexRoutes');
const auditLogRoutes = require('./auditLogRoutes');
const analyzerRoutes = require('./analyzerRoutes');
const queryExecutorRoutes = require('./queryExecutorRoutes');
const { getDbMode } = require('../config/db');
const clusters = require('../config/clusters');
const { requireCluster } = require('../middleware/auth');

const router = express.Router();

router.get('/health', (req, res) =>
  res.json({
    success: true,
    message: 'DBA Utility API is healthy',
    // 'mongodb' = the configured database; 'in-memory' = temporary fallback.
    database: getDbMode(),
    // The clusters this deployment serves; empty when it runs single-database.
    clusters: clusters.listPublic(),
    timestamp: new Date().toISOString(),
  })
);

router.use('/auth', authRoutes);
// Everything below reads or writes cluster data, so it must be served from
// exactly one cluster.
router.use('/manual-indexes', requireCluster, manualIndexRoutes);
router.use('/audit-logs', requireCluster, auditLogRoutes);
router.use('/analyzer', requireCluster, analyzerRoutes);
router.use('/query-executor', requireCluster, queryExecutorRoutes);

module.exports = router;
