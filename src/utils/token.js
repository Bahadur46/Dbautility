'use strict';

const crypto = require('crypto');
const { config } = require('../config/env');

/**
 * Compact HMAC-signed session tokens (`<payload-b64url>.<signature-b64url>`).
 *
 * Same shape and guarantees as an HS256 JWT — a tamper-proof, self-describing
 * bearer token — without pulling in a JWT library. Swap this module for
 * `jsonwebtoken` later and nothing else has to change.
 */

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(payloadJson) {
  return crypto.createHmac('sha256', config.auth.secret).update(payloadJson).digest('base64url');
}

/**
 * Issue a token for a user; expires after AUTH_TOKEN_TTL_MS.
 *
 * `cluster` is part of the signed payload, which is what makes a session
 * cluster-wise: the token names the one database the session may read or write,
 * and it cannot be swapped for another without breaking the signature.
 */
function createToken(user, cluster = '') {
  const now = Date.now();
  const payload = {
    sub: user.userId,
    name: user.userName,
    username: user.username,
    role: user.role,
    cluster: cluster || null,
    iat: now,
    exp: now + config.auth.tokenTtlMs,
    // Random per-login id, so a single session can be revoked on logout.
    jti: crypto.randomBytes(12).toString('hex'),
  };
  const json = JSON.stringify(payload);
  return { token: `${b64url(json)}.${sign(json)}`, payload };
}

/** Verify signature and expiry. Returns the payload, or null when invalid. */
function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;

  let json;
  try {
    json = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const expected = Buffer.from(sign(json));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;

  let payload;
  try {
    payload = JSON.parse(json);
  } catch {
    return null;
  }

  if (!payload.exp || Date.now() >= payload.exp) return null;
  return payload;
}

/** Pull the bearer token out of the Authorization header. */
function extractBearer(req) {
  const header = req.get('authorization') || '';
  const [scheme, value] = header.split(' ');
  if (!value || scheme.toLowerCase() !== 'bearer') return '';
  return value.trim();
}

module.exports = { createToken, verifyToken, extractBearer };
