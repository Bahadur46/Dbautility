'use strict';

const { config } = require('../config/env');
const { extractBearer } = require('../utils/token');
const authService = require('../services/authService');
const clusters = require('../config/clusters');
const { runWithCluster } = require('../config/clusterConnections');

/**
 * Resolves the acting user for the request and exposes it as `req.user`.
 *
 * A valid `Authorization: Bearer <token>` from POST /api/auth/login is the
 * real identity, and it always wins. When no token is present the request
 * falls back to the legacy `x-user-id` / `x-user-name` headers so existing
 * clients keep working; that path is flagged with `isAuthenticated: false`
 * and can never grant ADMIN, which is what `requireAuth` / `requireAdmin`
 * check before letting a request through.
 *
 * It also pins the request to the cluster its token was issued for: everything
 * downstream — models, index operations, the audit trail — runs against that
 * cluster's database and can see no other. Unauthenticated requests get no
 * cluster at all, so when clusters are configured they can reach no data.
 */
async function userContext(req, res, next) {
  const token = extractBearer(req);

  if (token) {
    try {
      const session = await authService.resolveToken(token);
      if (session) {
        const cluster = session.cluster || null;
        const account = session.user.toPublic();
        req.user = {
          ...account,
          // The cluster this session is working on — chosen after sign-in, and
          // null until it has been. `clusterPin` is the separate thing: the one
          // cluster the ACCOUNT is restricted to, blank for an account that may
          // use any.
          cluster: cluster ? cluster.key : null,
          clusterLabel: cluster ? cluster.label : null,
          clusterPin: account.cluster || null,
          // What the cluster picker offers, and whether one still has to be
          // picked before any data route will answer.
          clusters: authService.clustersFor(session.user),
          clusterRequired: clusters.isEnabled() && !cluster,
          isAuthenticated: true,
        };
        req.token = token;
        req.cluster = cluster;
        // next() runs inside the cluster context, so every handler after this
        // point resolves models against that cluster's connection.
        return cluster ? runWithCluster(cluster.key, () => next()) : next();
      }
    } catch (err) {
      return next(err);
    }
  }

  const userId = (req.get('x-user-id') || '').trim() || config.defaultUser.userId;
  const rawName = (req.get('x-user-name') || '').trim();

  let userName = config.defaultUser.userName;
  if (rawName) {
    try {
      userName = decodeURIComponent(rawName);
    } catch {
      userName = rawName;
    }
  }

  // Unauthenticated requests are always USER: a header can no longer claim
  // ADMIN now that a real sign-in exists.
  req.user = {
    userId,
    userName,
    role: 'USER',
    isAdmin: false,
    cluster: null,
    clusterLabel: null,
    clusterPin: null,
    // Nothing to choose from without a sign-in.
    clusters: [],
    isAuthenticated: false,
    // In cluster-wise mode there is no database to fall back to — the legacy
    // header path can only be used to identify a caller, never to read data.
    clustersRequired: clusters.isEnabled(),
  };
  return next();
}

module.exports = userContext;
