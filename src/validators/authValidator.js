'use strict';

const clusters = require('../config/clusters');

const MIN_PASSWORD = 6;

function validateLogin(payload = {}) {
  const errors = [];
  const username = typeof payload.username === 'string' ? payload.username.trim() : '';
  const password = typeof payload.password === 'string' ? payload.password : '';

  if (!username) errors.push({ field: 'username', message: 'Username is required' });
  if (!password) errors.push({ field: 'password', message: 'Password is required' });

  // Sign-in itself is cluster-free: one account, one password, whichever
  // cluster the session goes on to work on. A cluster may still be sent — a
  // client that already knows where it is headed skips the extra step — and
  // then it has to name a real one.
  if (clusters.isEnabled()) {
    const cluster = typeof payload.cluster === 'string' ? payload.cluster.trim() : '';
    if (cluster && !clusters.getCluster(cluster)) {
      errors.push({
        field: 'cluster',
        message: `"${cluster}" is not a known cluster — choose one from the list`,
      });
    }
  }

  return errors;
}

function validateChangePassword(payload = {}) {
  const errors = [];
  const current = typeof payload.currentPassword === 'string' ? payload.currentPassword : '';
  const next = typeof payload.newPassword === 'string' ? payload.newPassword : '';

  if (!current) errors.push({ field: 'currentPassword', message: 'Current password is required' });
  if (!next) {
    errors.push({ field: 'newPassword', message: 'New password is required' });
  } else if (next.length < MIN_PASSWORD) {
    errors.push({
      field: 'newPassword',
      message: `New password must be at least ${MIN_PASSWORD} characters`,
    });
  }

  return errors;
}

const USERNAME_PATTERN = /^[a-z0-9._-]+$/;

/** Shared checks for a username an administrator types into the Users page. */
function checkUsername(value, errors) {
  const username = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!username) {
    errors.push({ field: 'username', message: 'Username is required' });
  } else if (username.length < 3) {
    errors.push({ field: 'username', message: 'Username must be at least 3 characters' });
  } else if (username.length > 60) {
    errors.push({ field: 'username', message: 'Username must be at most 60 characters' });
  } else if (!USERNAME_PATTERN.test(username)) {
    errors.push({
      field: 'username',
      message: 'Use letters, digits, dot, dash or underscore — no spaces',
    });
  }
}

function checkPassword(value, errors, field = 'password') {
  const password = typeof value === 'string' ? value : '';
  if (!password) {
    errors.push({ field, message: 'Password is required' });
  } else if (password.length < MIN_PASSWORD) {
    errors.push({ field, message: `Password must be at least ${MIN_PASSWORD} characters` });
  }
}

/** Blank means "every cluster", which is the normal case. */
function checkCluster(value, errors) {
  if (value === undefined || value === null || value === '') return;
  const key = String(value).trim();
  if (key && !clusters.getCluster(key)) {
    errors.push({ field: 'cluster', message: `"${key}" is not a known cluster` });
  }
}

function checkDisplayName(value, errors) {
  const displayName = typeof value === 'string' ? value.trim() : '';
  if (!displayName) errors.push({ field: 'userName', message: 'Display name is required' });
  else if (displayName.length > 120)
    errors.push({ field: 'userName', message: 'Display name must be at most 120 characters' });
}

/** POST /api/auth/users — a new account. */
function validateCreateUser(payload = {}) {
  const errors = [];
  checkUsername(payload.username, errors);
  checkPassword(payload.password, errors);
  checkDisplayName(payload.userName, errors);

  if (payload.role !== undefined && !['ADMIN', 'USER'].includes(payload.role)) {
    errors.push({ field: 'role', message: 'Role must be ADMIN or USER' });
  }
  checkCluster(payload.cluster, errors);

  return errors;
}

/** PUT /api/auth/users/:userId — only the fields actually sent are checked. */
function validateUpdateUser(payload = {}) {
  const errors = [];
  if (payload.username !== undefined) checkUsername(payload.username, errors);
  if (payload.userName !== undefined) checkDisplayName(payload.userName, errors);

  if (payload.role !== undefined && !['ADMIN', 'USER'].includes(payload.role)) {
    errors.push({ field: 'role', message: 'Role must be ADMIN or USER' });
  }
  if (payload.isActive !== undefined && typeof payload.isActive !== 'boolean') {
    errors.push({ field: 'isActive', message: 'isActive must be true or false' });
  }
  checkCluster(payload.cluster, errors);

  return errors;
}

/** POST /api/auth/cluster — the cluster a signed-in session moves onto. */
function validateSelectCluster(payload = {}) {
  const errors = [];
  const cluster = typeof payload.cluster === 'string' ? payload.cluster.trim() : '';
  if (!cluster) {
    errors.push({ field: 'cluster', message: 'Select the cluster to work on' });
  } else if (!clusters.getCluster(cluster)) {
    errors.push({
      field: 'cluster',
      message: `"${cluster}" is not a known cluster — choose one from the list`,
    });
  }
  return errors;
}

/** POST /api/auth/users/:userId/password — an administrator setting one directly. */
function validateSetPassword(payload = {}) {
  const errors = [];
  checkPassword(payload.newPassword, errors, 'newPassword');
  return errors;
}

module.exports = {
  validateLogin,
  validateSelectCluster,
  validateChangePassword,
  validateCreateUser,
  validateUpdateUser,
  validateSetPassword,
};
