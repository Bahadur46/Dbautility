'use strict';

const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const required = ['MONGODB_URI'];

/** The one seeded account, and the environment prefix it reads. */
const SEED_ROLE = {
  prefix: 'ADMIN',
  userId: 'u-1001',
  username: 'admin',
  userName: 'System Administrator',
  password: 'Admin@123',
};

/**
 * The account to seed: one System Administrator for the whole deployment.
 *
 * Sign-in is not cluster-wise — LoginTB lives once, in the database MONGODB_URI
 * names — so there is one administrator however many clusters are configured,
 * and that account signs in to all of them. Any further accounts are created in
 * the app, on the Users page, not from the environment.
 *
 * ADMIN_USERNAME / ADMIN_PASSWORD / ADMIN_USER_NAME / ADMIN_USER_ID override
 * the built-in defaults below.
 */
function seedUsers() {
  const read = (name, fallback) => (process.env[name] || '').trim() || fallback;

  return [
    {
      userId: read(`${SEED_ROLE.prefix}_USER_ID`, SEED_ROLE.userId),
      username: read(`${SEED_ROLE.prefix}_USERNAME`, SEED_ROLE.username).toLowerCase(),
      userName: read(`${SEED_ROLE.prefix}_USER_NAME`, SEED_ROLE.userName),
      password: read(`${SEED_ROLE.prefix}_PASSWORD`, SEED_ROLE.password),
      role: 'ADMIN',
      // Blank means every cluster, which is the only thing a seeded account is.
      cluster: '',
    },
  ];
}

const config = {
  port: parseInt(process.env.PORT, 10) || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/dba_utility',
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 1000,
  },
  // Start on an embedded database when the configured MongoDB is
  // unreachable. On by default outside production; forced off in production.
  allowInMemoryFallbackSetting: String(process.env.ALLOW_INMEMORY_FALLBACK || '').toLowerCase(),
  // Database that indexes are created on. Empty means "the database in
  // MONGODB_URI" — set it when the app's own records should live apart from
  // the data being indexed.
  targetDb: (process.env.TARGET_DB || '').trim(),
  // VIEW entries are by far the most numerous. Set LOG_VIEW_ACTIONS=false to
  // stop recording them — the other three actions keep their full trail.
  logViewActions: String(process.env.LOG_VIEW_ACTIONS || '').toLowerCase() !== 'false',
  defaultUser: {
    userId: process.env.DEFAULT_USER_ID || 'u-1001',
    userName: process.env.DEFAULT_USER_NAME || 'System Administrator',
  },
  auth: {
    // Signs session tokens. A random secret is fine in development — it only
    // means restarts invalidate old tokens — but must be set in production.
    secret: process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex'),
    tokenTtlMs: parseInt(process.env.AUTH_TOKEN_TTL_MS, 10) || 8 * 60 * 60 * 1000,
    // The one account created on boot when it does not exist yet. It is not
    // per-cluster: LoginTB is central, so this administrator serves every
    // cluster there is.
    seedUsers: seedUsers(),
  },
};

config.isProduction = config.nodeEnv === 'production';
config.allowInMemoryFallback =
  !config.isProduction && config.allowInMemoryFallbackSetting !== 'false';

/** Warn loudly in production when critical env vars are missing. */
function assertEnv() {
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length && config.isProduction) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (config.isProduction && !process.env.AUTH_SECRET) {
    throw new Error('AUTH_SECRET must be set in production, or every restart logs all users out');
  }
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.warn(
      `[env] Using defaults for missing variables: ${missing.join(', ')} (copy .env.example to .env)`
    );
  }
}

module.exports = { config, assertEnv, seedUsersFor: seedUsers };
