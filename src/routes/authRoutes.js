'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const controller = require('../controllers/authController');
const { validate } = require('../middleware/validate');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const {
  validateLogin,
  validateSelectCluster,
  validateChangePassword,
  validateCreateUser,
  validateUpdateUser,
  validateSetPassword,
} = require('../validators/authValidator');

const router = express.Router();

// A tight limit on the credential endpoints only, so password guessing is
// throttled far below the app-wide request limit. Successful sign-ins do not
// count, so a legitimate user is never locked out by their own activity.
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { success: false, message: 'Too many login attempts, please try again in 15 minutes.' },
});

// Public: the app shows the clusters this deployment serves before sign-in,
// and the caller's own choices once there is a session.
router.get('/clusters', controller.listClusters);
// Sign-in is cluster-free — one account for the whole deployment.
router.post('/login', credentialLimiter, validate(validateLogin), controller.login);
// ...and the cluster is chosen straight afterwards, on the session that login
// issued. The same call switches cluster later, without signing in again. It
// returns a NEW token and revokes the one it was called with.
router.post(
  '/cluster',
  requireAuth,
  validate(validateSelectCluster),
  controller.selectCluster
);
router.post('/logout', controller.logout);
router.get('/me', requireAuth, controller.me);
router.post(
  '/change-password',
  credentialLimiter,
  requireAuth,
  validate(validateChangePassword),
  controller.changePassword
);
// Account management. Administrators only, all of it — an ordinary account can
// read nothing here and change nothing but its own password.
router.get('/users', requireAdmin, controller.listUsers);
router.post('/users', requireAdmin, validate(validateCreateUser), controller.createUser);
router.put('/users/:userId', requireAdmin, validate(validateUpdateUser), controller.updateUser);
router.post(
  '/users/:userId/password',
  requireAdmin,
  validate(validateSetPassword),
  controller.setUserPassword
);
router.delete('/users/:userId', requireAdmin, controller.deleteUser);
// The sign-in history — of the caller's own cluster only.

module.exports = router;
