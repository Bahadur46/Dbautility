'use strict';

const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const required = ['MONGODB_URI'];

/**
 * Origins allowed when CORS_ORIGIN is not configured.
 *
 * A deployment reads this from the host's environment, and when that has not
 * been set yet the old default — localhost alone — left the deployed frontend
 * locked out of its own API with a 403 that looks like an application bug.
 * Listing the known frontend hosts here means a fresh deployment serves the
 * real site immediately; CORS_ORIGIN still overrides this entirely whenever a
 * deployment needs a different set.
 *
 * Both schemes of each host are listed on purpose: an origin is matched as an
 * exact string, so a page served over http:// sends "http://host" and an
 * https:// entry does not match it.
 */
const DEFAULT_CORS_ORIGINS = [
  'https://dba.erpthemes.com',
  'http://dba.erpthemes.com',
  // Vite dev server, and `vite preview` for checking a production build.
  'http://localhost:5173',
  'http://localhost:4173',
];

/**
 * The environment prefix the optional bootstrap account reads, and the values
 * that are safe to default.
 *
 * There is deliberately NO default password. A built-in one means every
 * deployment that never set ADMIN_PASSWORD ships the same publicly known
 * administrator credentials, which on an internet-facing API is a way in for
 * anyone who has read this repository.
 */
const SEED_ROLE = {
  prefix: 'ADMIN',
  userId: 'u-1001',
  userName: 'System Administrator',
};

/**
 * The bootstrap administrator to create on first boot — or none at all.
 *
 * Seeding is OPT-IN: it happens only when ADMIN_USERNAME and ADMIN_PASSWORD
 * are both set. A database that already holds its accounts — the normal case
 * once a deployment is running — needs no seed, and returning an empty list
 * leaves those accounts strictly alone.
 *
 * This exists to solve one problem: a brand-new, empty database that nobody
 * can sign in to. Once a real administrator exists, remove ADMIN_PASSWORD;
 * further accounts are created in the app, on the Users page.
 *
 * Sign-in is not cluster-wise — LoginTB lives once, in the database
 * MONGODB_URI names — so there is one administrator however many clusters are
 * configured, and that account signs in to all of them.
 */
function seedUsers() {
  const read = (name, fallback = '') => (process.env[name] || '').trim() || fallback;

  const username = read(`${SEED_ROLE.prefix}_USERNAME`).toLowerCase();
  const password = read(`${SEED_ROLE.prefix}_PASSWORD`);

  // Both, or nothing. A username without a password cannot be signed in to,
  // and a password without a username has no account to belong to.
  if (!username || !password) return [];

  return [
    {
      userId: read(`${SEED_ROLE.prefix}_USER_ID`, SEED_ROLE.userId),
      username,
      userName: read(`${SEED_ROLE.prefix}_USER_NAME`, SEED_ROLE.userName),
      password,
      role: 'ADMIN',
      // Blank means every cluster, which is the only thing a seeded account is.
      cluster: '',
    },
  ];
}

const config = {
  port: parseInt(process.env.PORT, 10) || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  mongoUri: process.env.MONGODB_URI || 'mongodb+srv://bahadur3028_db_user:HDTiC60Z7wBPxaey@clusterdhs.c0ai6pq.mongodb.net',
  corsOrigin: (process.env.CORS_ORIGIN || DEFAULT_CORS_ORIGINS.join(','))
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
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'In a deployment these come from the host\'s environment, not from .env — ' +
        '.env is gitignored and is never part of the build artifact. ' +
        'On Azure App Service set them under Configuration > Application settings ' +
        '(deploy/set-azure-appsettings.ps1 pushes them for you).'
    );
  }
  if (config.isProduction && !process.env.AUTH_SECRET) {
    throw new Error('AUTH_SECRET must be set in production, or every restart logs all users out');
  }
  // A bootstrap password is for filling an empty database, not for running
  // one. Left in place it is a standing credential in the deployment's
  // configuration, and it is re-applied on every restart.
  if (config.isProduction && process.env.ADMIN_PASSWORD) {
    // eslint-disable-next-line no-console
    console.warn(
      '[env] ADMIN_PASSWORD is set in production — it seeds a bootstrap administrator on every ' +
        'start. Remove it once a real administrator account exists.'
    );
  }

  if (missing.length) {
    // eslint-disable-next-line no-console
    console.warn(
      `[env] Using defaults for missing variables: ${missing.join(', ')} (copy .env.example to .env)`
    );
  }
}

module.exports = { config, assertEnv, seedUsersFor: seedUsers };
