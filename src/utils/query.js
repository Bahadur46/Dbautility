'use strict';

/** Escape user input so it cannot inject regex metacharacters into a query. */
function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Case-insensitive "contains" matcher.
 * The explicit `$regex` / `$options` form is used throughout rather than native
 * RegExp literals — it is the portable representation understood by every
 * MongoDB-compatible engine and driver version.
 */
function containsInsensitive(value) {
  return { $regex: escapeRegex(value), $options: 'i' };
}

/** Case-insensitive exact-match matcher, used for uniqueness checks. */
function equalsInsensitive(value) {
  return { $regex: `^${escapeRegex(value)}$`, $options: 'i' };
}

module.exports = { escapeRegex, containsInsensitive, equalsInsensitive };
