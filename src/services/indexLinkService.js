'use strict';

const OptimizationActivity = require('../models/OptimizationActivity');

/**
 * Which long query an index was built to fix.
 *
 * The dashboard counts tasks, and an index made for a long query is part of
 * that task rather than a task of its own. Nobody states the link when they
 * create an index, so it is inferred — and inferring it from time alone links
 * the wrong query whenever a collection has two, or claims an index that was
 * built for something else entirely. So the index is matched on what it is
 * for: its key fields against the fields the query filters and sorts on.
 *
 * A candidate is scored, and the best one wins:
 *
 *   exact   the index has exactly the keys the analysis recommended.   100
 *   fields  the index's leading field is one the query uses, and at    50–90
 *           least half its fields are. Without the leading field the
 *           query planner could not use the index for this query, so it
 *           cannot have been the fix.
 *   time    neither side records any fields, so there is nothing to      10
 *           compare. Accepted only when it is the one long query on that
 *           collection in the window — with two, time alone is a guess.
 *
 * Ties go to the query recorded before the index (a fix follows its problem),
 * then to the nearer one in time. `_id` is ignored when comparing: it is in
 * half the indexes on every collection and says nothing about which query.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
// A field match is real evidence, so it may reach further than a guess by time.
const FIELD_WINDOW_MS = 30 * DAY_MS;
const TIME_WINDOW_MS = 7 * DAY_MS;

const SCORE = { exact: 100, fieldsBase: 50, fieldsRange: 40, time: 10 };

/** Field names a filter document touches, through $and/$or/$nor and $elemMatch. */
function filterFields(doc, out = new Set(), prefix = '') {
  if (!doc || typeof doc !== 'object') return out;
  if (Array.isArray(doc)) {
    for (const item of doc) filterFields(item, out, prefix);
    return out;
  }
  for (const [key, value] of Object.entries(doc)) {
    if (key.startsWith('$')) {
      // Logical operators hold whole sub-filters; $elemMatch holds fields of
      // the array element, which an index names as "array.field".
      if (key === '$elemMatch') filterFields(value, out, prefix);
      else if (['$and', '$or', '$nor'].includes(key)) filterFields(value, out, prefix);
      continue;
    }
    const field = prefix ? `${prefix}.${key}` : key;
    out.add(field);
    if (value && typeof value === 'object' && !Array.isArray(value) && value.$elemMatch) {
      filterFields(value.$elemMatch, out, field);
    }
  }
  return out;
}

/** Ordered key fields of a recorded index, from either shape it is stored in. */
function indexFieldsOf(indexActivity) {
  const detail = indexActivity.subjectDetail || {};
  if (Array.isArray(detail.keys)) return detail.keys.map((k) => String(k.field));
  const spec = detail.keys || detail.key;
  return spec && typeof spec === 'object' ? Object.keys(spec) : [];
}

/** Every field a long query is known to use, and the index recommended for it. */
function queryShapeOf(longQuery) {
  const detail = longQuery.subjectDetail || {};
  const fields = filterFields(detail.match);
  for (const field of Object.keys(detail.sort || {})) fields.add(field);
  const recommended =
    detail.recommendedIndex && detail.recommendedIndex.keys
      ? Object.keys(detail.recommendedIndex.keys)
      : [];
  for (const field of recommended) fields.add(field);
  return { fields, recommended };
}

const withoutId = (list) => list.filter((f) => f !== '_id');

/**
 * How well one index fits one long query, or null when it does not fit.
 * `onlyCandidate` allows the time fallback — see the header.
 */
function scoreMatch(indexActivity, longQuery, { onlyCandidate = false } = {}) {
  const keys = indexFieldsOf(indexActivity);
  const { fields, recommended } = queryShapeOf(longQuery);

  if (recommended.length && keys.length && recommended.join('|') === keys.join('|')) {
    return { method: 'exact', score: SCORE.exact };
  }

  const indexFields = withoutId(keys);
  const queryFields = new Set(withoutId([...fields]));

  if (indexFields.length && queryFields.size) {
    if (!queryFields.has(indexFields[0])) return null;
    const covered = indexFields.filter((f) => queryFields.has(f)).length;
    const share = covered / indexFields.length;
    if (share < 0.5) return null;
    return {
      method: 'fields',
      score: Math.round(SCORE.fieldsBase + SCORE.fieldsRange * share),
      matchedFields: indexFields.filter((f) => queryFields.has(f)),
    };
  }

  // Nothing to compare on one side or the other.
  if (!onlyCandidate) return null;
  const gap = Math.abs(new Date(indexActivity.timestamp) - new Date(longQuery.timestamp));
  return gap <= TIME_WINDOW_MS ? { method: 'time', score: SCORE.time } : null;
}

/** Order two scored candidates for one index: best first. */
function better(a, b, indexAt) {
  if (a.match.score !== b.match.score) return b.match.score - a.match.score;
  const aBefore = new Date(a.query.timestamp) <= indexAt;
  const bBefore = new Date(b.query.timestamp) <= indexAt;
  if (aBefore !== bBefore) return aBefore ? -1 : 1;
  return Math.abs(indexAt - new Date(a.query.timestamp)) - Math.abs(indexAt - new Date(b.query.timestamp));
}

/** The best long query for an index among already-loaded candidates. */
function pickBest(indexActivity, longQueries) {
  const indexAt = new Date(indexActivity.timestamp);
  const onlyCandidate = longQueries.length === 1;
  const scored = longQueries
    .map((query) => ({ query, match: scoreMatch(indexActivity, query, { onlyCandidate }) }))
    .filter((c) => c.match);
  if (!scored.length) return null;
  scored.sort((a, b) => better(a, b, indexAt));
  return scored[0];
}

const QUERY_FIELDS = '_id timestamp status subjectDetail.match subjectDetail.sort subjectDetail.recommendedIndex';

/** Long queries on the index's collection that could have been its fix. */
function candidateQueries({ cluster, databaseName, collectionName, timestamp }) {
  const at = new Date(timestamp);
  return OptimizationActivity.find({
    activityType: 'LONG_QUERY',
    cluster: cluster || '',
    databaseName: databaseName || '',
    collectionName,
    // No fix was made for an ignored query.
    status: { $ne: 'IGNORED' },
    timestamp: { $gte: new Date(at - FIELD_WINDOW_MS), $lte: new Date(at.getTime() + FIELD_WINDOW_MS) },
  })
    .select(QUERY_FIELDS)
    .lean();
}

/** The best long query for one index, loaded from the database. */
async function bestLongQueryFor(indexActivity) {
  if (!indexActivity.collectionName) return null;
  return pickBest(indexActivity, await candidateQueries(indexActivity));
}

// Links the server inferred. Only these may be moved to a better-fitting query;
// a link a person made stays where they put it.
const AUTO_METHODS = ['exact', 'fields', 'time'];

/**
 * Which of these indexes (all on one collection) have since been dropped, as a
 * Set of activity ids. An INDEX_DROPPED row for the same name at or after the
 * create means the index is gone, so it cannot be anyone's fix now.
 */
async function droppedIndexIds(indexes) {
  if (!indexes.length) return new Set();
  const { cluster, databaseName, collectionName } = indexes[0];
  const drops = await OptimizationActivity.find({
    activityType: 'INDEX_DROPPED',
    cluster: cluster || '',
    databaseName: databaseName || '',
    collectionName,
    subject: { $in: indexes.map((i) => i.subject) },
  })
    .select('subject timestamp')
    .lean();
  const out = new Set();
  for (const index of indexes) {
    const created = new Date(index.timestamp);
    if (drops.some((d) => d.subject === index.subject && new Date(d.timestamp) >= created)) {
      out.add(String(index._id));
    }
  }
  return out;
}

/**
 * Move an automatically linked index to a query it fits strictly better.
 * Conditional on the index still being where it was read and still an
 * automatic link, so it never takes a manual link or races another move.
 */
function moveLink(indexActivity, best) {
  return OptimizationActivity.updateOne(
    {
      _id: indexActivity._id,
      longQueryId: indexActivity.longQueryId,
      'longQueryLink.method': { $in: AUTO_METHODS },
    },
    {
      $set: {
        longQueryId: best.query._id,
        longQueryLink: { method: best.match.method, score: best.match.score },
      },
    }
  );
}

/** Write a link, only onto an index nobody has linked since it was read. */
function saveLink(indexId, best) {
  return OptimizationActivity.updateOne(
    { _id: indexId, longQueryId: null },
    {
      $set: {
        longQueryId: best.query._id,
        longQueryLink: { method: best.match.method, score: best.match.score },
      },
    }
  );
}

module.exports = {
  FIELD_WINDOW_MS,
  AUTO_METHODS,
  droppedIndexIds,
  moveLink,
  filterFields,
  indexFieldsOf,
  queryShapeOf,
  scoreMatch,
  pickBest,
  bestLongQueryFor,
  saveLink,
};
