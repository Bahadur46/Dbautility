'use strict';

/**
 * Create one login account in LoginTB, from the terminal.
 *
 * Accounts are central — they live in the database MONGODB_URI names, not in
 * any cluster's — so an account created here can sign in once and then work on
 * whichever cluster it picks. Pin it to a single cluster with --cluster when it
 * should only ever reach that one.
 *
 * This is the same code path the Users page uses, so the account it writes is
 * indistinguishable from one an administrator creates in the app: `appManaged`,
 * which means a restart will never overwrite it from .env.
 *
 *   npm run create:user -- --username=rahul --password=Rahul@123 --name="Rahul Sharma"
 *   npm run create:user -- --username=ops --password=Ops@12345 --name="Ops" --role=ADMIN
 *   npm run create:user -- --username=dot.dba --password=Dot@12345 --name="DotIn DBA" --cluster=dotin
 *
 * Flags:
 *   --username   what is typed at sign-in (letters, digits, . - _)   required
 *   --password   at least 6 characters                               required
 *   --name       display name shown in the app                       required
 *   --role       ADMIN or USER                                       default USER
 *   --cluster    pin to one cluster; omit for "any cluster"          default any
 *   --id         explicit user id; omit to get the next free u-NNNN
 */

const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../config/db');
const authService = require('../services/authService');
const clusters = require('../config/clusters');
const { validateCreateUser } = require('../validators/authValidator');

/** Read `--name=value` and `--name value` alike. */
function readArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > -1) {
      args[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      args[arg.slice(2)] = next && !next.startsWith('--') ? (i += 1, next) : 'true';
    }
  }
  return args;
}

async function run() {
  const args = readArgs(process.argv.slice(2));

  const payload = {
    username: args.username || args.user || '',
    password: args.password || args.pass || '',
    userName: args.name || args.userName || '',
    role: (args.role || 'USER').toUpperCase(),
    cluster: args.cluster || '',
    userId: args.id || args.userId || '',
  };

  // The same checks the API applies, so the terminal cannot create an account
  // the app would have refused.
  const errors = validateCreateUser(payload);
  if (errors.length) {
    throw new Error(
      `${errors.map((e) => `${e.field}: ${e.message}`).join('\n  ')}\n\n` +
        '  npm run create:user -- --username=<name> --password=<secret> --name="<display name>"'
    );
  }

  // The accounts database is the app's own connection, which is what
  // connectDB() opens. No cluster connection is needed: nothing about an
  // account lives in a cluster.
  await connectDB();

  const user = await authService.createUser(payload);

  const pin = user.cluster
    ? `pinned to ${(clusters.getCluster(user.cluster) || {}).label || user.cluster}`
    : 'may use any cluster';
  /* eslint-disable no-console */
  console.log(`\n[create:user] Created "${user.username}" (${user.userId})`);
  console.log(`              ${user.userName} — ${user.role}, ${pin}`);
  console.log('              Sign in with POST /api/auth/login, then choose a cluster');
  console.log('              with POST /api/auth/cluster.\n');
  /* eslint-enable no-console */

  await disconnectDB();
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`\n[create:user] Failed:\n  ${err.message}\n`);
  process.exit(1);
});
