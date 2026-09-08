'use strict';

const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * Login accounts, stored in the `LoginTB` collection.
 *
 * The two credential fields are named `UserName` and `Password` as they appear
 * in the database. `Password` holds the password as typed — hashing is
 * deliberately not applied here, so anyone able to read LoginTB reads every
 * live credential. It is still `select: false`, which keeps it out of API
 * responses, and the sign-in flow itself is unchanged.
 */
const userSchema = new mongoose.Schema(
  {
    // Stable id carried on audit entries — matches the old x-user-id values.
    userId: {
      type: String,
      required: true,
      trim: true,
    },
    // The login identifier typed on the sign-in form.
    UserName: {
      type: String,
      required: [true, 'Username is required'],
      trim: true,
      lowercase: true,
      minlength: [3, 'Username must be at least 3 characters'],
      maxlength: [60, 'Username must be at most 60 characters'],
    },
    Password: {
      type: String,
      required: true,
      // Never serialised — no response may leak the credential.
      select: false,
    },
    // Display name shown in the UI and written to the audit trail.
    displayName: {
      type: String,
      required: [true, 'Display name is required'],
      trim: true,
      maxlength: [120, 'Display name must be at most 120 characters'],
    },
    role: {
      type: String,
      enum: {
        values: ['ADMIN', 'USER'],
        message: '{VALUE} is not a supported role',
      },
      default: 'USER',
      index: true,
    },
    // The cluster this account signs in to, e.g. "ananda".
    //
    // A row already belongs to one cluster by living in that cluster's own
    // database, so this records which one rather than deciding it. The seeded
    // administrator carries its cluster's key here; a sign-in is refused when
    // the cluster picked on the form does not match. Blank means the account is
    // not tied to any one cluster.
    cluster: {
      type: String,
      trim: true,
      lowercase: true,
      default: '',
      index: true,
    },
    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
    /**
     * True once this account is owned by the app rather than by the environment.
     *
     * The seeded administrator is defined by the ADMIN_* variables, and boot
     * re-applies those values so that editing .env actually takes effect. That would fight an administrator editing the
     * same account in the app — their change would be undone on the next
     * restart. So creating an account here, or editing a seeded one, sets this
     * flag and boot leaves the row alone from then on.
     *
     * Default false, which is also what rows written before this existed read
     * as: they were environment-managed, and they stay that way.
     */
    appManaged: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        delete ret.Password;
        return ret;
      },
    },
  }
);

/**
 * LoginTB holds sign-in attempt rows beside the accounts. Only attempts carry
 * an `outcome`, so every account query excludes the rows that have one — that
 * way callers keep writing `User.findOne({ userId })` and never see history.
 */
for (const op of [
  'count',
  'countDocuments',
  'distinct',
  'find',
  'findOne',
  'findOneAndDelete',
  'findOneAndUpdate',
  'updateMany',
  'updateOne',
  'deleteMany',
  'deleteOne',
]) {
  userSchema.pre(op, function excludeLoginHistory() {
    const current = this.getQuery();
    if (current.outcome === undefined) this.where({ outcome: { $exists: false } });
  });
}

/** Store the password exactly as typed. */
userSchema.methods.setPassword = function setPassword(plain) {
  this.Password = String(plain);
};

/** Compare a submitted password against the stored one. */
userSchema.methods.checkPassword = function checkPassword(plain) {
  return typeof this.Password === 'string' && String(plain) === this.Password;
};

/** The shape returned to the client and embedded in tokens. */
userSchema.methods.toPublic = function toPublic() {
  return {
    id: this.id,
    userId: this.userId,
    username: this.UserName,
    userName: this.displayName,
    role: this.role,
    isAdmin: this.role === 'ADMIN',
    cluster: this.cluster || null,
    isActive: this.isActive,
    lastLoginAt: this.lastLoginAt,
    // Lets the UI say why an account it did not create looks the way it does.
    appManaged: Boolean(this.appManaged),
    createdAt: this.createdAt,
  };
};

// LoginTB holds two kinds of row: the accounts and the sign-in history
// (see LoginRecord). Only an account row carries `UserName`, so the account
// uniqueness is scoped to rows that have it — otherwise every login attempt
// collides with the account it belongs to (E11000 on userId / UserName).
// The filter tests `$exists: true`: MongoDB rejects `$exists: false` here.
const ACCOUNT_ROWS = { partialFilterExpression: { UserName: { $exists: true } } };
// Named, because LoginRecord indexes the same two field names on this
// collection and the default names would collide.
userSchema.index({ userId: 1 }, { unique: true, name: 'account_userId_unique', ...ACCOUNT_ROWS });
// Unique within this database, which is one cluster's — every cluster has an
// administrator called "admin", and they do not collide because they are not
// in the same collection.
userSchema.index(
  { UserName: 1 },
  { unique: true, name: 'account_username_unique', ...ACCOUNT_ROWS }
);

// Not central: each cluster keeps its accounts in its own database, so this
// resolves against the connection of the cluster being signed in to.
module.exports = defineModel('User', userSchema, 'LoginTB');
