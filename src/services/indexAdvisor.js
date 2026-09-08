'use strict';

/**
 * Index advisor — pure logic, no database access.
 *
 * Turns a query shape (filter + sort) into the index that would serve it,
 * following MongoDB's **ESR rule**: Equality fields first, then Sort fields,
 * then Range fields. That order matters because MongoDB reads a compound key
 * left to right: equality narrows the scan to a contiguous section of the
 * index, a sort can then be satisfied by reading that section in order, and a
 * range can only be applied last without breaking either of the first two.
 *
 * Everything here is deterministic and side-effect free so it can be tested
 * exhaustively against real profiler document shapes.
 */

// Operators that constrain a field to a single value (or a small set).
const EQUALITY_OPERATORS = new Set(['$eq', '$in']);

// Operators that select a span of values — these must come last in the key.
const RANGE_OPERATORS = new Set([
  '$gt', '$gte', '$lt', '$lte', '$ne', '$nin', '$exists', '$regex', '$mod',
  '$size', '$all', '$elemMatch', '$bitsAllSet', '$bitsAnySet', '$near', '$geoWithin',
]);

// Top-level operators that combine sub-expressions rather than name a field.
const LOGICAL_OPERATORS = new Set(['$and', '$or', '$nor', '$not']);

/** Fields MongoDB always indexes, so never worth recommending on their own. */
const ALWAYS_INDEXED = new Set(['_id']);

/**
 * Walk a filter and classify every field path as equality, range or text.
 * `$and` is flattened because its branches all constrain the same documents.
 * `$or` is reported separately: a single compound index cannot serve an $or,
 * MongoDB needs one usable index per branch.
 */
function classifyFilter(filter = {}, acc = null) {
  const out = acc || { equality: [], range: [], text: false, orBranches: [], unsupported: [] };

  for (const [key, value] of Object.entries(filter || {})) {
    if (key === '$text') {
      out.text = true;
      continue;
    }

    if (key === '$and') {
      (value || []).forEach((sub) => classifyFilter(sub, out));
      continue;
    }

    if (key === '$or' || key === '$nor') {
      (value || []).forEach((sub) => {
        const branch = classifyFilter(sub);
        out.orBranches.push(branch);
      });
      continue;
    }

    if (LOGICAL_OPERATORS.has(key) || key.startsWith('$')) {
      out.unsupported.push(key);
      continue;
    }

    // A plain value, or a document of operators.
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const operators = Object.keys(value).filter((k) => k.startsWith('$'));
      if (operators.length === 0) {
        // Nested document compared whole — an equality match on the field.
        pushUnique(out.equality, key);
        continue;
      }
      if (operators.some((op) => RANGE_OPERATORS.has(op))) pushUnique(out.range, key);
      else if (operators.some((op) => EQUALITY_OPERATORS.has(op))) pushUnique(out.equality, key);
      else out.unsupported.push(key);
      continue;
    }

    pushUnique(out.equality, key);
  }

  return out;
}

function pushUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

/** Normalise a sort spec into an ordered [{ field, direction }] list. */
function normaliseSort(sort) {
  if (!sort || typeof sort !== 'object') return [];
  return Object.entries(sort)
    .filter(([field]) => !field.startsWith('$'))
    .map(([field, direction]) => ({ field, direction: Number(direction) === -1 ? -1 : 1 }));
}

/**
 * Build the recommended key specification for one query shape.
 * Returns null when there is nothing worth indexing.
 */
function recommendKeys({ filter = {}, sort = null } = {}) {
  const classified = classifyFilter(filter);
  const sortFields = normaliseSort(sort);

  if (classified.text) {
    // A $text query needs a text index; field order is irrelevant there.
    return {
      keys: [],
      text: true,
      notes: ['This query uses $text, which requires a TEXT index on the searched fields.'],
      esr: classified,
    };
  }

  const notes = [];
  const sortFieldNames = sortFields.map((s) => s.field);

  // E — equality fields, in the order they appear in the filter.
  const equality = classified.equality.filter((f) => !ALWAYS_INDEXED.has(f));

  // S — sort fields that are not already pinned by an equality match.
  //     An equality-matched field has one value, so it contributes no ordering.
  const sortPart = sortFields.filter((s) => !equality.includes(s.field) && !ALWAYS_INDEXED.has(s.field));

  // R — range fields, minus anything already placed.
  const range = classified.range.filter(
    (f) => !equality.includes(f) && !sortFieldNames.includes(f) && !ALWAYS_INDEXED.has(f)
  );

  const keys = [
    ...equality.map((field) => ({ field, direction: 1 })),
    ...sortPart.map((s) => ({ field: s.field, direction: s.direction })),
    ...range.map((field) => ({ field, direction: 1 })),
  ];

  if (keys.length === 0) return null;

  if (classified.orBranches.length) {
    notes.push(
      'This query uses $or. MongoDB needs a usable index for every branch — one compound index cannot serve them all.'
    );
  }
  if (classified.unsupported.length) {
    notes.push(`Ignored operators that cannot be indexed directly: ${classified.unsupported.join(', ')}`);
  }
  if (range.length > 1) {
    notes.push(
      'More than one range field: only the first can use the index efficiently, the rest are filtered afterwards.'
    );
  }

  return {
    keys,
    text: false,
    notes,
    esr: {
      equality,
      sort: sortPart.map((s) => `${s.field}: ${s.direction}`),
      range,
    },
  };
}

/** Human-readable justification for a recommendation. */
function explainRecommendation(esr) {
  const parts = [];
  if (esr.equality.length) parts.push(`equality on ${esr.equality.join(', ')}`);
  if (esr.sort.length) parts.push(`sort by ${esr.sort.join(', ')}`);
  if (esr.range.length) parts.push(`range on ${esr.range.join(', ')}`);
  if (parts.length === 0) return 'No indexable fields found in this query.';
  return `Ordered by the Equality-Sort-Range rule: ${parts.join(', then ')}.`;
}

/** Compare two key lists for exact equality, order and direction included. */
function keysEqual(a = [], b = []) {
  if (a.length !== b.length) return false;
  return a.every((k, i) => k.field === b[i].field && Number(k.direction) === Number(b[i].direction));
}

/**
 * True when `prefix` is a leading prefix of `keys`, allowing for the fact that
 * MongoDB can walk an index backwards to satisfy a sort. Directions therefore
 * have to either all match or all be inverted — and only for the fields whose
 * order actually matters. A field pinned by an equality match has a single
 * value, so its direction in the index is irrelevant.
 */
function isPrefixOf(prefix = [], keys = [], orderSensitiveFields = null) {
  if (prefix.length > keys.length) return false;
  if (!prefix.every((k, i) => k.field === keys[i].field)) return false;

  // Which of these fields' directions actually constrain the match.
  const matters = (field) => (orderSensitiveFields ? orderSensitiveFields.includes(field) : true);
  const relevant = prefix
    .map((k, i) => ({ a: Number(k.direction), b: Number(keys[i].direction), field: k.field }))
    .filter((p) => matters(p.field) && p.a !== 0 && p.b !== 0 && !Number.isNaN(p.a) && !Number.isNaN(p.b));

  if (relevant.length === 0) return true;
  const allSame = relevant.every((p) => p.a === p.b);
  const allInverted = relevant.every((p) => p.a === -p.b);
  return allSame || allInverted;
}

/** Convert MongoDB's `{ field: 1 }` key document into our key list shape. */
function keyDocToList(keyDoc = {}) {
  return Object.entries(keyDoc).map(([field, direction]) => ({
    field,
    direction: direction === 'text' ? 'text' : Number(direction),
  }));
}

/**
 * Compare a recommendation against the indexes a collection already has.
 *
 *  - `coveredBy`   an existing index already serves the query (the
 *                  recommendation is a prefix of it, or identical).
 *  - `supersedes`  existing indexes that the recommendation would make
 *                  redundant, because they are prefixes of it.
 */
function compareWithExisting(recommendedKeys, existingIndexes = [], orderSensitiveFields = null) {
  let coveredBy = null;
  const supersedes = [];

  for (const idx of existingIndexes) {
    if (idx.name === '_id_') continue;
    const existingKeys = keyDocToList(idx.key || {});

    if (keysEqual(recommendedKeys, existingKeys)) {
      coveredBy = { name: idx.name, reason: 'identical to this index' };
      break;
    }
    if (isPrefixOf(recommendedKeys, existingKeys, orderSensitiveFields)) {
      coveredBy = {
        name: idx.name,
        reason: 'this index already starts with these fields, so MongoDB can use it',
      };
      break;
    }
    if (isPrefixOf(existingKeys, recommendedKeys, orderSensitiveFields)) {
      supersedes.push(idx.name);
    }
  }

  return { coveredBy, supersedes };
}

/** Suggest an index name from a collection and key list. */
function suggestName(collectionName, keys) {
  const parts = keys
    .map((k) => `${k.field.replace(/\./g, '_')}${k.direction === -1 ? '_desc' : ''}`)
    .join('_');
  return `idx_${collectionName}_${parts}`.slice(0, 120);
}

/**
 * Full recommendation for one query shape, including how it relates to the
 * indexes that already exist on the collection.
 */
function advise({ collectionName, filter, sort, existingIndexes = [] }) {
  const recommendation = recommendKeys({ filter, sort });

  if (!recommendation) {
    return {
      recommended: false,
      message: 'This query has no indexable filter or sort — an index would not help.',
    };
  }

  if (recommendation.text) {
    return {
      recommended: true,
      indexType: 'TEXT',
      keys: [],
      reason: 'This query uses $text and needs a TEXT index on the searched fields.',
      notes: recommendation.notes,
      coveredBy: null,
      supersedes: [],
    };
  }

  // Only the sort portion of the key is order-sensitive; equality fields pin a
  // single value, so their direction in the index makes no difference.
  const orderSensitive = recommendation.esr.sort.map((entry) => entry.split(':')[0].trim());
  const { coveredBy, supersedes } = compareWithExisting(
    recommendation.keys,
    existingIndexes,
    orderSensitive
  );

  return {
    recommended: !coveredBy,
    indexType: recommendation.keys.length > 1 ? 'COMPOUND' : 'SINGLE',
    keys: recommendation.keys,
    suggestedName: suggestName(collectionName || 'collection', recommendation.keys),
    reason: explainRecommendation(recommendation.esr),
    esr: recommendation.esr,
    notes: recommendation.notes,
    coveredBy,
    supersedes,
  };
}

module.exports = {
  advise,
  recommendKeys,
  classifyFilter,
  normaliseSort,
  compareWithExisting,
  keyDocToList,
  isPrefixOf,
  keysEqual,
  suggestName,
  explainRecommendation,
};
