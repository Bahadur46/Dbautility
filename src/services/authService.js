'use strict';

const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const { createToken, verifyToken } = require('../utils/token');
const clusters = require('../config/clusters');
const { runOnAuthDb, getConnection } = require('../config/clusterConnections');
const loginRecords = require('./loginRecordService');

/**
 * One sign-in for the whole deployment, and a cluster chosen afterwards.
 *
 * Each cluster keeps its accounts in its own database: Ananda's LoginTB is in
 * Ananda's database, Kamdhenu's in Kamdhenu's. The cluster named on the sign-in
 * form is therefore half the credential — it decides which LoginTB is read at
 * all — so the same username in two clusters is two separate accounts, and an
 * account in one cluster is invisible to every other.
 *
 * The chosen cluster rides on the token as a signed claim, so it cannot be
 * tampered with, and decides which data (manual indexes, audit trail, the
 * analyzer) the session works on. selectCluster() can move a session to another
 * cluster without a second sign-in, but only to a cluster the account is
 * allowed to use — which, for a cluster-pinned account, is only its own. Until
 * a cluster is chosen the session can reach no data route at all;
 * `requireCluster` sees to that.
 *
 * A System Administrator is seeded into each cluster: same login name, same
 * password, one row in each cluster's own LoginTB. An account created
 * afterwards in the app may leave `cluster` blank, which means it is not
 * recorded against any one cluster — it still only exists in the database it
 * was created in.
 *
 * Sessions are stateless signed tokens; logout works by remembering the token
 * id (`jti`) until its natural expiry, so a logged-out token stops being
 * accepted immediately. The set lives in process memory — a restart clears it,
 * which is safe because a restart with a generated AUTH_SECRET invalidates
 * every issued token anyway.
 */
const revoked = new Map(); // jti -> exp (ms)

/** Drop revocation entries whose tokens have expired on their own. */
function pruneRevoked() {
  const now = Date.now();
  for (const [jti, exp] of revoked) {
    if (exp <= now) revoked.delete(jti);
  }
}

/**
 * Resolve a cluster a request names, insisting it is real and reachable.
 *
 * Sign-in no longer needs one: signing in is a single act for the whole
 * deployment, and the cluster is chosen afterwards. A blank value therefore
 * means "not chosen yet" and yields null, which is also what single-database
 * mode always gets.
 */
function resolveCluster(value, { required = false } = {}) {
  if (!clusters.isEnabled()) return null;

  const raw = String(value || '').trim();
  if (!raw) {
    if (!required) return null;
    throw ApiError.badRequest('Select a valid cluster', [
      { field: 'cluster', message: 'Select a valid cluster' },
    ]);
  }

  const cluster = clusters.getCluster(raw);
  if (!cluster) {
    throw ApiError.badRequest('Select a valid cluster', [
      { field: 'cluster', message: 'Select a valid cluster' },
    ]);
  }
  if (!getConnection(cluster.key)) {
    throw new ApiError(503, `The ${cluster.label} cluster is not reachable right now`);
  }
  return cluster;
}

/**
 * The clusters this account may choose from, right now.
 *
 * Every configured cluster that is actually connected, narrowed to the account's
 * own when it is pinned to one. This is what the app shows on the cluster
 * picker after sign-in.
 */
function clustersFor(user) {
  if (!clusters.isEnabled()) return [];
  return clusters.clusters
    .filter((c) => getConnection(c.key))
    .filter((c) => !user || !user.cluster || user.cluster === c.key)
    .map(({ key, label }) => ({ key, label }));
}

/** Refuse a cluster the account is not allowed to work on. */
function assertMayUseCluster(user, cluster) {
  if (!cluster || !user.cluster) return;
  if (user.cluster !== cluster.key) {
    const own = clusters.getCluster(user.cluster);
    throw ApiError.forbidden(
      own
        ? `This account belongs to ${own.label} — sign in to ${own.label} instead of ${cluster.label}`
        : `This account is not allowed to use the ${cluster.label} cluster`
    );
  }
}

/**
 * Validate credentials and issue a session token for the chosen cluster.
 *
 * Every attempt that gets as far as a username — accepted or refused — leaves
 * a row in the login history, stamped with the cluster it was made against.
 * The record is written before the error is thrown, so a refusal is never
 * silent; writing it can never change what the caller is told.
 */
async function login({ username, password, cluster: clusterKey }, req = null) {
  // Optional: a client that already knows which cluster it wants can name it
  // and be signed straight in there. Left out — the normal case — the session
  // starts with no cluster and picks one next, through selectCluster().
  let cluster = resolveCluster(clusterKey);

  // Read from the accounts database of the cluster being signed in to: the
  // username is looked up there and nowhere else, so an account in another
  // cluster cannot answer for this one.
  return runOnAuthDb(async () => {
    const name = String(username).trim().toLowerCase();
    const user = await User.findOne({ UserName: name }).select('+Password');

    // The same message covers an unknown user and a wrong password, so the
    // response cannot be used to discover which usernames exist. The history
    // does distinguish them — it is only readable by someone already signed in.
    if (!user || !user.checkPassword(password)) {
      await loginRecords.record({
        username,
        user,
        cluster,
        success: false,
        outcome: 'INVALID_CREDENTIALS',
        reason: user ? 'Wrong password' : 'No such account',
        req,
      });
      throw new ApiError(401, 'Invalid username or password');
    }
    if (!user.isActive) {
      await loginRecords.record({
        username,
        user,
        cluster,
        success: false,
        outcome: 'ACCOUNT_INACTIVE',
        reason: 'Account is deactivated',
        req,
      });
      throw ApiError.forbidden('This account has been deactivated');
    }

    try {
      assertMayUseCluster(user, cluster);
    } catch (err) {
      await loginRecords.record({
        username,
        user,
        cluster,
        success: false,
        outcome: 'CLUSTER_NOT_ALLOWED',
        reason: err.message,
        req,
      });
      throw err;
    }

    // No cluster named on the form: start the session on the first cluster the
    // account may use, so a sign-in lands ready to work instead of on a token
    // that every data route refuses. selectCluster() still switches it later.
    if (!cluster && clusters.isEnabled()) {
      const [first] = clustersFor(user);
      if (first) cluster = resolveCluster(first.key);
    }

    user.lastLoginAt = new Date();
    await user.save();

    // Signed from the public shape, so the claims use the API's field names
    // rather than LoginTB's column names.
    const { token, payload } = createToken(user.toPublic(), cluster ? cluster.key : '');
    const expiresAt = new Date(payload.exp);

    await loginRecords.record({
      username,
      user,
      cluster,
      success: true,
      outcome: 'SUCCESS',
      reason: '',
      // The token id, so the sign-out can close this exact row.
      sessionId: payload.jti,
      expiresAt,
      req,
    });

    return {
      token,
      expiresAt: expiresAt.toISOString(),
      user: user.toPublic(),
      cluster: cluster ? { key: cluster.key, label: cluster.label } : null,
      // What the cluster picker offers next. Empty in single-database mode,
      // where there is nothing to choose.
      clusters: clustersFor(user),
      // True while the session has no cluster yet: it can read the account and
      // pick a cluster, and reach no data until it has.
      clusterRequired: clusters.isEnabled() && !cluster,
    };
  }, cluster);
}

/**
 * Put a signed-in session onto a cluster — the step after login.
 *
 * The account is already proven, so no password is asked for again: what comes
 * back is the same user on a fresh token that names the chosen cluster. The old
 * token is revoked in the same breath, so exactly one token is live per session
 * and a session cannot keep a door open on the cluster it just left.
 *
 * Switching clusters is the same operation, which is the point: one login
 * serves every cluster the account is allowed on.
 */
async function selectCluster(token, clusterKey, req = null) {
  const session = await resolveToken(token);
  if (!session) throw new ApiError(401, 'Authentication required — sign in to continue');

  const cluster = resolveCluster(clusterKey, { required: true });
  const { user, payload: previous } = session;

  try {
    assertMayUseCluster(user, cluster);
  } catch (err) {
    await loginRecords.record({
      username: user.UserName,
      user,
      cluster,
      success: false,
      outcome: 'CLUSTER_NOT_ALLOWED',
      reason: err.message,
      req,
    });
    throw err;
  }

  // The session moves, so the token it was riding on stops being accepted and
  // the history row it opened is closed.
  revoked.set(previous.jti, previous.exp);
  pruneRevoked();
  await loginRecords.recordLogout(previous.jti, session.cluster);

  return runOnAuthDb(async () => {
    const { token: next, payload } = createToken(user.toPublic(), cluster.key);
    const expiresAt = new Date(payload.exp);

    await loginRecords.record({
      username: user.UserName,
      user,
      cluster,
      success: true,
      outcome: 'SUCCESS',
      reason: '',
      sessionId: payload.jti,
      expiresAt,
      req,
    });

    return {
      token: next,
      expiresAt: expiresAt.toISOString(),
      user: user.toPublic(),
      cluster: { key: cluster.key, label: cluster.label },
      clusters: clustersFor(user),
      clusterRequired: false,
    };
  }, cluster);
}

/** Revoke the session behind a token. Idempotent — a stale token is a no-op. */
async function logout(token) {
  const payload = verifyToken(token);
  if (payload && payload.jti) {
    revoked.set(payload.jti, payload.exp);
    pruneRevoked();
    // The row lives in the accounts database of the cluster the session was
    // issued for, which the token names.
    const cluster = clusters.getCluster(payload.cluster);
    // Closes the history row this session opened. A missing row (a token from
    // before the restart, say) is simply nothing to close.
    await loginRecords.recordLogout(payload.jti, cluster);
    return true;
  }
  return false;
}

/**
 * Resolve a bearer token to its live user and cluster, or null when it is not
 * usable. Both the account and the data come from the cluster the token names,
 * so a token can only ever reach the cluster it was issued for.
 */
async function resolveToken(token) {
  const payload = verifyToken(token);
  if (!payload || revoked.has(payload.jti)) return null;

  let cluster = null;
  if (clusters.isEnabled() && payload.cluster) {
    cluster = clusters.getCluster(payload.cluster);
    // A token for a cluster that has since been removed or gone offline is no
    // longer usable — its session has nowhere to be served from.
    if (!cluster || !getConnection(cluster.key)) return null;
  }
  // A token with no cluster is a signed-in session that has not chosen one yet.
  // It is a real identity, so it can read its own account and pick a cluster;
  // `requireCluster` keeps it away from every data route until it has.

  return runOnAuthDb(async () => {
    const user = await User.findOne({ userId: payload.sub });
    if (!user || !user.isActive) return null;
    if (cluster && user.cluster && user.cluster !== cluster.key) return null;
    return { user, payload, cluster };
  }, cluster);
}

/** Change the signed-in user's own password. */
async function changePassword(userId, { currentPassword, newPassword }) {
  return runOnAuthDb(async () => {
    const user = await User.findOne({ userId }).select('+Password');
    if (!user) throw ApiError.notFound('User not found');

    if (!user.checkPassword(currentPassword)) {
      throw ApiError.badRequest('Current password is incorrect', [
        { field: 'currentPassword', message: 'Current password is incorrect' },
      ]);
    }
    if (user.checkPassword(newPassword)) {
      throw ApiError.badRequest('The new password must differ from the current one', [
        { field: 'newPassword', message: 'The new password must differ from the current one' },
      ]);
    }

    user.setPassword(newPassword);
    await user.save();
    return user.toPublic();
  });
}

/**
 * Account management, performed by an administrator inside the app.
 *
 * Accounts no longer have to come from .env: they are created, renamed, moved
 * between clusters, deactivated and removed here. Anything touched this way is
 * marked `appManaged`, which stops boot re-applying the environment over it.
 */

/** The next free "u-NNNN" id, so a new account never collides with a seed. */
async function nextUserId() {
  const users = await User.find({ userId: /^u-\d+$/ }).select('userId').lean();
  const highest = users.reduce((max, u) => {
    const n = parseInt(String(u.userId).slice(2), 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 1000);
  return `u-${highest + 1}`;
}

/**
 * Refuse a username already taken in this cluster's accounts database.
 *
 * Names are unique per cluster, not deployment-wide — every cluster has its own
 * "admin" — and the query runs against one cluster's database, so that scoping
 * needs no clause of its own.
 */
async function assertUsernameFree(username, exceptUserId = null) {
  const clash = await User.findOne({ UserName: username });
  if (clash && clash.userId !== exceptUserId) {
    throw ApiError.badRequest('That username is already taken', [
      { field: 'username', message: 'That username is already taken' },
    ]);
  }
}

/** The cluster an account may be pinned to, or '' for every cluster. */
function normalizePin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const cluster = clusters.getCluster(raw);
  if (!cluster) {
    throw ApiError.badRequest('Unknown cluster', [
      { field: 'cluster', message: 'Pick one of the configured clusters, or leave it blank' },
    ]);
  }
  return cluster.key;
}

/** Create an account. */
async function createUser({ username, password, userName, role, cluster, userId }) {
  return runOnAuthDb(async () => {
    const name = String(username || '').trim().toLowerCase();
    await assertUsernameFree(name);

    const id = String(userId || '').trim() || (await nextUserId());
    if (await User.findOne({ userId: id })) {
      throw ApiError.badRequest('That user id is already in use', [
        { field: 'userId', message: 'That user id is already in use' },
      ]);
    }

    const user = new User({
      userId: id,
      UserName: name,
      displayName: String(userName || '').trim(),
      role: role === 'ADMIN' ? 'ADMIN' : 'USER',
      cluster: normalizePin(cluster),
      isActive: true,
      // Created here, so the environment never owns it.
      appManaged: true,
    });
    user.setPassword(password);
    await user.save();
    return user.toPublic();
  });
}

/**
 * Change an account's details. Only the fields present are touched.
 *
 * `actor` is the signed-in administrator, so the rules that protect the
 * console from locking itself out can be applied: nobody may take away their
 * own administrator rights or deactivate themselves, and the last remaining
 * active administrator cannot be demoted or switched off by anyone.
 */
async function updateUser(userId, patch, actor) {
  return runOnAuthDb(async () => {
    const user = await User.findOne({ userId });
    if (!user) throw ApiError.notFound('User not found');

    const isSelf = actor && actor.userId === user.userId;

    if (patch.username !== undefined) {
      const name = String(patch.username).trim().toLowerCase();
      await assertUsernameFree(name, user.userId);
      user.UserName = name;
    }
    if (patch.userName !== undefined) user.displayName = String(patch.userName).trim();
    if (patch.cluster !== undefined) user.cluster = normalizePin(patch.cluster);

    if (patch.role !== undefined) {
      const role = patch.role === 'ADMIN' ? 'ADMIN' : 'USER';
      if (role !== 'ADMIN' && user.role === 'ADMIN') {
        if (isSelf) {
          throw ApiError.forbidden('You cannot remove your own administrator rights');
        }
        await assertNotLastAdmin(user);
      }
      user.role = role;
    }

    if (patch.isActive !== undefined) {
      const active = Boolean(patch.isActive);
      if (!active) {
        if (isSelf) throw ApiError.forbidden('You cannot deactivate your own account');
        if (user.role === 'ADMIN') await assertNotLastAdmin(user);
      }
      user.isActive = active;
    }

    // Whatever it was before, this account is now the app's to manage.
    user.appManaged = true;
    await user.save();
    return user.toPublic();
  });
}

/** Refuse a change that would leave the console with no active administrator. */
async function assertNotLastAdmin(user) {
  const others = await User.countDocuments({
    role: 'ADMIN',
    isActive: true,
    userId: { $ne: user.userId },
  });
  if (others === 0) {
    throw ApiError.forbidden(
      'This is the only active administrator — promote another account first, ' +
        'or nobody would be able to manage the console.'
    );
  }
}

/** Set an account's password without knowing the old one. Administrators only. */
async function setPassword(userId, newPassword) {
  return runOnAuthDb(async () => {
    const user = await User.findOne({ userId }).select('+Password');
    if (!user) throw ApiError.notFound('User not found');
    user.setPassword(newPassword);
    user.appManaged = true;
    await user.save();
    return user.toPublic();
  });
}

/** Remove an account outright. */
async function deleteUser(userId, actor) {
  return runOnAuthDb(async () => {
    const user = await User.findOne({ userId });
    if (!user) throw ApiError.notFound('User not found');
    if (actor && actor.userId === user.userId) {
      throw ApiError.forbidden('You cannot delete the account you are signed in with');
    }
    if (user.role === 'ADMIN' && user.isActive) await assertNotLastAdmin(user);

    await User.deleteOne({ userId });
    // The account is gone, but its id stays on every audit entry it produced —
    // the trail is not rewritten by a deletion.
    return user.toPublic();
  });
}

/** The account roster, with the cluster each account is pinned to. */
async function listUsers() {
  return runOnAuthDb(async () => {
    const users = await User.find({}).sort({ displayName: 1 });
    return users.map((u) => u.toPublic());
  });
}

module.exports = {
  login,
  selectCluster,
  clustersFor,
  logout,
  resolveToken,
  changePassword,
  listUsers,
  createUser,
  updateUser,
  setPassword,
  deleteUser,
};
