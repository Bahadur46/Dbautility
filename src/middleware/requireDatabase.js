'use strict';

const { getDbMode, getDbError, isDbReady } = require('../config/db');

/**
 * Answer 503 while the database is not usable.
 *
 * The API binds its port before the database is up, so that a hosted
 * deployment always has something listening and /api/health can say what is
 * wrong. That leaves a window — and, when the database is misconfigured, a
 * permanent state — where a data route has nothing to read. Saying so plainly
 * is far more useful than a driver timeout thirty seconds later, or a platform
 * 503 page with no explanation.
 */
function requireDatabase(req, res, next) {
  if (isDbReady()) return next();

  const connecting = getDbMode() === 'connecting';
  return res.status(503).json({
    success: false,
    message: connecting
      ? 'The API is still connecting to its database — retry in a moment'
      : 'The API cannot reach its database. Check MONGODB_URI on the server.',
    database: getDbMode(),
    reason: getDbError() || undefined,
  });
}

module.exports = requireDatabase;
