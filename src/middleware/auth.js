'use strict';

const ApiError = require('../utils/ApiError');
const clusters = require('../config/clusters');

/** Reject the request unless a valid session token was presented. */
function requireAuth(req, res, next) {
  if (!req.user || !req.user.isAuthenticated) {
    return next(new ApiError(401, 'Authentication required — sign in to continue'));
  }
  return next();
}

/** Reject the request unless the signed-in user is an administrator. */
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAuthenticated) {
    return next(new ApiError(401, 'Authentication required — sign in to continue'));
  }
  if (!req.user.isAdmin) {
    return next(ApiError.forbidden('This action requires an administrator account'));
  }
  return next();
}

/**
 * Reject the request unless it is pinned to a cluster.
 *
 * In cluster-wise mode there is no shared database to serve: a request without
 * a cluster token has nothing to read. This keeps the legacy `x-user-id`
 * header path usable for identification while making it powerless to reach
 * data. When no clusters are configured the app is single-database and this is
 * a no-op.
 */
function requireCluster(req, res, next) {
  if (!clusters.isEnabled()) return next();
  if (!req.cluster) {
    return next(
      new ApiError(401, 'Sign in and choose a cluster — every request is served from one cluster')
    );
  }
  return next();
}

module.exports = { requireAuth, requireAdmin, requireCluster };
