'use strict';

const express = require('express');
const authRoutes = require('./authRoutes');
const manualIndexRoutes = require('./manualIndexRoutes');
const auditLogRoutes = require('./auditLogRoutes');
const queryExecutorRoutes = require('./queryExecutorRoutes');
const dashboardRoutes = require('./dashboardRoutes');
const { getDbMode, getDbError } = require('../config/db');
const clusters = require('../config/clusters');
const { requireAuth, requireCluster } = require('../middleware/auth');
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
// Its own routes decide individually what a caller must already be.
router.use('/auth', requireDatabase, authRoutes);
// Everything below needs a database, a signed-in caller, and exactly one
// cluster to be served from.
//
// requireAuth is not redundant next to requireCluster. requireCluster starts
// with `if (!clusters.isEnabled()) return next()`, so on a deployment where
// the CLUSTER_* variables are not configured it passes everything through —
// and these routes were then reachable with no token at all: the whole index
// catalogue and audit trail readable, and indexes creatable and droppable, by
// anyone who could reach the URL. Authentication must not depend on another
// feature happening to be switched on.
const dataRoute = [requireDatabase, requireAuth, requireCluster];

router.use('/manual-indexes', ...dataRoute, manualIndexRoutes);
router.use('/audit-logs', ...dataRoute, auditLogRoutes);
router.use('/query-executor', ...dataRoute, queryExecutorRoutes);
// The dashboard opens on every cluster at once and narrows on ?cluster=, so
// unlike the audit trail it deliberately reaches past the cluster the session
// is pinned to. That is safe only because sign-in is not cluster-wise — one
// account signs in once for the deployment and then picks a cluster, so this
// shows nothing a user could not reach by switching. It still needs the full
// guard: its activity table prints database names, collection names, index
// keys and usernames.
router.use('/dashboard/dba', ...dataRoute, dashboardRoutes);

module.exports = router;
