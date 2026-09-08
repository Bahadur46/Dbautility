'use strict';

const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');
const authService = require('../services/authService');
const { extractBearer } = require('../utils/token');
const clusters = require('../config/clusters');

/**
 * GET /api/auth/clusters — the clusters that can be worked on.
 *
 * Public, so the app can show what the deployment serves before anyone signs
 * in. Called with a session it answers with that account's own choices instead:
 * the reachable clusters, narrowed to one when the account is pinned.
 */
const listClusters = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Clusters retrieved successfully',
    data: req.user && req.user.isAuthenticated ? req.user.clusters : clusters.listPublic(),
  })
);

/** POST /api/auth/login */
const login = asyncHandler(async (req, res) => {
  // `req` goes along so the attempt is recorded with its address and agent.
  const result = await authService.login(req.body, req);
  const where = result.cluster
    ? ` — signed in to ${result.cluster.label}`
    : result.clusterRequired
    ? ' — choose a cluster to continue'
    : '';
  return sendSuccess(res, {
    message: `Welcome back, ${result.user.userName}${where}`,
    data: result,
  });
});

/**
 * POST /api/auth/cluster — put the signed-in session onto a cluster.
 *
 * The step after login, and the same one used to switch later: one sign-in
 * serves every cluster the account is allowed on. Returns a fresh token; the
 * one used to call this is revoked, so the client must store the new one.
 */
const selectCluster = asyncHandler(async (req, res) => {
  const result = await authService.selectCluster(extractBearer(req), req.body.cluster, req);
  return sendSuccess(res, {
    message: `Now working on ${result.cluster.label}`,
    data: result,
  });
});

/** POST /api/auth/logout */
const logout = asyncHandler(async (req, res) => {
  await authService.logout(extractBearer(req));
  return sendSuccess(res, { message: 'Signed out successfully' });
});

/** GET /api/auth/me — who the current token belongs to. */
const me = asyncHandler(async (req, res) =>
  sendSuccess(res, { message: 'Current user', data: req.user })
);

/** POST /api/auth/change-password */
const changePassword = asyncHandler(async (req, res) => {
  const user = await authService.changePassword(req.user.userId, req.body);
  return sendSuccess(res, { message: 'Password updated successfully', data: user });
});

/** GET /api/auth/users — the account roster (administrators only). */
const listUsers = asyncHandler(async (req, res) => {
  const users = await authService.listUsers();
  return sendSuccess(res, { message: 'Users retrieved successfully', data: users });
});

/** POST /api/auth/users — create an account. Administrators only. */
const createUser = asyncHandler(async (req, res) => {
  const user = await authService.createUser(req.body);
  return sendSuccess(res, {
    statusCode: 201,
    message: `Account "${user.username}" created`,
    data: user,
  });
});

/** PUT /api/auth/users/:userId — change an account's details. */
const updateUser = asyncHandler(async (req, res) => {
  const user = await authService.updateUser(req.params.userId, req.body, req.user);
  return sendSuccess(res, { message: `Account "${user.username}" updated`, data: user });
});

/**
 * POST /api/auth/users/:userId/password
 * Set an account's password without knowing the old one — how an administrator
 * helps someone who is locked out.
 */
const setUserPassword = asyncHandler(async (req, res) => {
  const user = await authService.setPassword(req.params.userId, req.body.newPassword);
  return sendSuccess(res, { message: `Password set for "${user.username}"`, data: user });
});

/** DELETE /api/auth/users/:userId — remove an account. */
const deleteUser = asyncHandler(async (req, res) => {
  const user = await authService.deleteUser(req.params.userId, req.user);
  return sendSuccess(res, {
    message: `Account "${user.username}" removed. Its past actions stay in the audit trail.`,
    data: user,
  });
});

module.exports = {
  listClusters,
  login,
  selectCluster,
  logout,
  me,
  changePassword,
  listUsers,
  createUser,
  updateUser,
  setUserPassword,
  deleteUser,
};
