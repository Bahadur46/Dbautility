'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Turn a MongoDB operation document into a diagnosis.
 *
 * The input is whatever the server already said about a slow operation — a
 * `db.currentOp()` entry, a `system.profile` document, or the JSON blob a slow
 * query logs. Those three describe the same thing in slightly different words,
 * so everything below reads them through one shape.
 *
 * Nothing here talks to a database. It is arithmetic and pattern-matching over
 * a document the caller already has, which is what lets it work on deployments
 * where the profiler is unavailable — Atlas M0/M2/M5 included — and lets it be
 * tested without a server.
 */

/** First non-undefined of several possible field names. */
function pick(doc, ...names) {
  for (const name of names) {
    const value = name.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** `ERP_40019.Finance_AccountsOnboarded` -> its two halves. */
function splitNamespace(ns) {
  const text = String(ns || '');
  const dot = text.indexOf('.');
  if (dot < 0) return { databaseName: '', collectionName: text };
  return { databaseName: text.slice(0, dot), collectionName: text.slice(dot + 1) };
}

/** The `$match` of an aggregate, or the filter of a find. */
function predicateDocument(command) {
  if (!command || typeof command !== 'object') return {};
  if (Array.isArray(command.pipeline)) {
    // Only the leading $match can use an index; a $match after a $group is
    // filtering rows the pipeline has already built, and no index reaches it.
    const first = command.pipeline.find((stage) => stage && stage.$match);
    const leading = command.pipeline[0];
    if (first && leading && leading.$match) return leading.$match;
    return {};
  }
  return command.filter || command.query || {};
}

/** The sort a command asks for, if any. */
function sortDocument(command) {
  if (!command || typeof command !== 'object') return {};
  if (Array.isArray(command.pipeline)) {
    const stage = command.pipeline.find((s) => s && s.$sort);
    return stage ? stage.$sort : {};
  }
  return command.sort || {};
}

// Operators that select a range of values rather than one.
const RANGE_OPERATORS = new Set(['$gt', '$gte', '$lt', '$lte', '$ne', '$nin', '$not']);

/**
 * Classify each predicate field as equality, range, or regex.
 *
 * This is the input to ESR — equality, sort, range — which is the ordering rule
 * a compound index has to follow to be useful. A regex is grouped with range
 * because it cannot seek to a single value either.
 */
function classifyPredicates(match) {
  const equality = [];
  const range = [];
  const regex = [];

  for (const [field, value] of Object.entries(match || {})) {
    // $and / $or / $expr describe structure rather than one field, and an index
    // recommendation drawn from them would be a guess.
    if (field.startsWith('$')) continue;

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const keys = Object.keys(value);
      // Extended JSON spells a regex as $regularExpression; the driver and the
      // shell both spell it $regex. Both mean the same thing here.
      if (keys.includes('$regularExpression') || keys.includes('$regex')) {
        const spec = value.$regularExpression || {};
        regex.push({
          field,
          pattern: spec.pattern !== undefined ? spec.pattern : value.$regex,
          options: spec.options !== undefined ? spec.options : value.$options || '',
        });
        continue;
      }
      if (keys.includes('$in')) {
        // $in is equality against a set — it still seeks, so it belongs with E.
        equality.push(field);
        continue;
      }
      if (keys.some((k) => RANGE_OPERATORS.has(k))) {
        range.push(field);
        continue;
      }
      if (keys.includes('$eq')) {
        equality.push(field);
        continue;
      }
      // A nested document compared whole is an equality match on that value.
      equality.push(field);
      continue;
    }

    equality.push(field);
  }

  return { equality, range, regex };
}

/** The index name and key spec out of "IXSCAN { a: 1, b: 1 }". */
function parsePlanSummary(planSummary) {
  const text = String(planSummary || '');
  const stage = text.split(/[\s{]/)[0] || '';
  const braces = text.indexOf('{');
  const keys = [];
  if (braces >= 0) {
    const inner = text.slice(braces + 1, text.lastIndexOf('}'));
    for (const part of inner.split(',')) {
      const [field] = part.split(':');
      const name = String(field || '').trim();
      if (name) keys.push(name);
    }
  }
  return { stage, indexFields: keys };
}

/**
 * One operation document, read into the fields everything else here uses.
 *
 * Every duration is normalised to milliseconds and every size to bytes, so a
 * caller never has to remember which of `millis`, `durationMillis` and
 * `planningTimeMicros` a particular source happened to use.
 */
function parseOp(op) {
  if (!op || typeof op !== 'object') {
    throw ApiError.badRequest('Provide the operation document as a JSON object');
  }

  const command = op.command || op.originatingCommand || {};
  const ns = pick(op, 'ns') || `${command.$db || ''}.${command.aggregate || command.find || ''}`;
  const { databaseName, collectionName } = splitNamespace(ns);

  if (!collectionName) {
    throw ApiError.badRequest(
      'Could not tell which collection this ran on — the document needs an "ns", or a command naming one'
    );
  }

  const durationMillis = Number(pick(op, 'durationMillis', 'workingMillis', 'millis') || 0);
  const planningMicros = Number(pick(op, 'planningTimeMicros') || 0);
  const plan = parsePlanSummary(op.planSummary);
  const match = predicateDocument(command);

  return {
    databaseName,
    collectionName,
    namespace: ns,
    operation: command.aggregate ? 'aggregate' : command.find ? 'find' : op.op || 'command',
    command,
    match,
    sort: sortDocument(command),
    predicates: classifyPredicates(match),

    durationMillis,
    planningMillis: Math.round(planningMicros / 1000),
    keysExamined: Number(pick(op, 'keysExamined') || 0),
    docsExamined: Number(pick(op, 'docsExamined') || 0),
    nreturned: Number(pick(op, 'nreturned', 'nReturned') || 0),
    bytesRead: Number(pick(op, 'storage.data.bytesRead') || 0),
    readMillis: Math.round(Number(pick(op, 'storage.data.timeReadingMicros') || 0) / 1000),
    cpuMillis: Math.round(Number(pick(op, 'cpuNanos') || 0) / 1e6),
    numYields: Number(pick(op, 'numYields') || 0),
    peakMemBytes: Number(pick(op, 'peakTrackedMemBytes') || 0),
    fromMultiPlanner: Boolean(op.fromMultiPlanner),

    planSummary: op.planSummary || '',
    planStage: plan.stage,
    indexFields: plan.indexFields,
    // The index the plan actually used, named the way MongoDB names one built
    // from those fields. Empty on a collection scan.
    indexUsed: plan.stage === 'COLLSCAN' ? '' : plan.indexFields.join('_') || '',
    queryHash: op.queryShapeHash || op.planCacheShapeHash || op.queryHash || '',
  };
}

/**
 * The index this query wants, in ESR order.
 *
 * Equality fields first, because each one narrows the scan to a single value.
 * Then the sort, so the index can supply the ordering rather than the server
 * sorting in memory. Range and regex fields last: they can only ever bound one
 * end of the scan, and anything after them in the key loses its bounds.
 *
 * Returns null when there is nothing to recommend — no predicate at all, or one
 * built from $or/$expr, where a key order drawn from it would be a guess.
 */
function recommendIndex(parsed) {
  const { equality, range, regex } = parsed.predicates;
  const sortFields = Object.keys(parsed.sort || {}).filter((f) => !f.startsWith('$'));

  const keys = [];
  const seen = new Set();
  const add = (field) => {
    if (!field || seen.has(field)) return;
    seen.add(field);
    keys.push(field);
  };

  equality.forEach(add);
  sortFields.forEach(add);
  range.forEach(add);
  // A regex cannot seek, but carrying the field in the index still lets it be
  // tested on index keys instead of on fetched documents.
  regex.map((r) => r.field).forEach(add);

  if (!keys.length) return null;

  const spec = {};
  for (const field of keys) spec[field] = parsed.sort?.[field] === -1 ? -1 : 1;
  return {
    keys: spec,
    name: keys.map((f) => `${f}_${spec[f]}`).join('_'),
    command:
      `db.getSiblingDB("${parsed.databaseName}").getCollection("${parsed.collectionName}")` +
      `.createIndex(${JSON.stringify(spec)})`,
  };
}

/**
 * What is wrong with this operation, in the order a reader should care.
 *
 * Each finding names the measurement it rests on, so none of them has to be
 * taken on trust — and so a finding that does not apply is simply absent rather
 * than hedged.
 */
function findings(parsed) {
  const out = [];
  const returned = Math.max(parsed.nreturned, 1);

  if (parsed.docsExamined / returned >= 100) {
    out.push({
      key: 'examined-to-returned',
      severity: 'high',
      title: 'Reads far more than it returns',
      detail:
        `${parsed.docsExamined.toLocaleString()} documents were examined to return ` +
        `${parsed.nreturned.toLocaleString()} — a ratio of ${Math.round(parsed.docsExamined / returned).toLocaleString()}:1. ` +
        'An index that matches the predicate turns most of that work into a key scan.',
    });
  }

  if (parsed.durationMillis && parsed.planningMillis / parsed.durationMillis >= 0.3) {
    out.push({
      key: 'planning-dominates',
      severity: 'high',
      title: 'Most of the time went on planning, not executing',
      detail:
        `${parsed.planningMillis.toLocaleString()} ms of ${parsed.durationMillis.toLocaleString()} ms ` +
        `(${Math.round((parsed.planningMillis / parsed.durationMillis) * 100)}%) was spent choosing a plan` +
        (parsed.fromMultiPlanner
          ? ', with the multi-planner trial-running candidates over cold data. A plan that is clearly best is chosen faster and cached.'
          : '.'),
    });
  }

  // An index whose leading fields are not all in the predicate cannot use the
  // fields after them as bounds — the classic reason a query "has an index" and
  // is still slow.
  if (parsed.indexFields.length) {
    const predicateFields = new Set([
      ...parsed.predicates.equality,
      ...parsed.predicates.range,
      ...parsed.predicates.regex.map((r) => r.field),
    ]);
    const firstUnused = parsed.indexFields.findIndex((f) => !predicateFields.has(f));
    const boundedTail = firstUnused >= 0 && firstUnused < parsed.indexFields.length - 1;
    if (boundedTail) {
      out.push({
        key: 'index-prefix-gap',
        severity: 'high',
        title: 'The index it chose stops bounding early',
        detail:
          `The plan used { ${parsed.indexFields.join(', ')} }, but "${parsed.indexFields[firstUnused]}" ` +
          'is not in this query. Every field after it can only be a filter, never a bound, so the scan is ' +
          'far wider than the predicate.',
      });
    }
  }

  if (parsed.bytesRead >= 1e9) {
    out.push({
      key: 'io-bound',
      severity: 'medium',
      title: 'Read from disk, not from cache',
      detail:
        `${(parsed.bytesRead / 1e9).toFixed(2)} GB was read in ${parsed.readMillis.toLocaleString()} ms — ` +
        `against ${parsed.cpuMillis.toLocaleString()} ms of CPU. This is waiting on storage, so cutting the ` +
        'documents fetched matters more than cutting the work per document.',
    });
  }

  for (const r of parsed.predicates.regex) {
    if (String(r.options || '').includes('i') && !String(r.pattern || '').startsWith('^')) {
      out.push({
        key: 'unanchored-regex',
        severity: 'medium',
        title: `"${r.field}" uses a case-insensitive, unanchored regex`,
        detail:
          `/${r.pattern}/${r.options} cannot seek in an index — it can only be tested against keys or ` +
          'documents. Carrying the field in the index avoids the document fetch; a stored lowercase copy ' +
          'matched with an anchored prefix, or a case-insensitive collation, is what makes it seek.',
      });
    }
  }

  // A pipeline that only counts needs no document at all, so the right index
  // makes it covered — the single biggest win available here.
  const pipeline = Array.isArray(parsed.command.pipeline) ? parsed.command.pipeline : [];
  const group = pipeline.find((s) => s && s.$group);
  const countOnly =
    group &&
    Object.entries(group.$group).every(
      ([k, v]) => k === '_id' || (v && typeof v === 'object' && v.$sum !== undefined)
    );
  if (countOnly && parsed.docsExamined > 0) {
    out.push({
      key: 'coverable',
      severity: 'high',
      title: 'This only counts — it never needs the documents',
      detail:
        'The pipeline returns a count, so an index holding every field in the predicate answers it from ' +
        `keys alone. That removes the ${parsed.docsExamined.toLocaleString()} document fetches entirely.`,
    });
  }

  return out;
}

/** A one-line description of the query, for the activity's subject. */
function describe(parsed) {
  const fields = [
    ...parsed.predicates.equality,
    ...parsed.predicates.range,
    ...parsed.predicates.regex.map((r) => r.field),
  ];
  return `${parsed.operation} ${parsed.collectionName} { ${fields.join(', ')} }`.slice(0, 500);
}

/** The parsed op as a `before` measurement on an optimisation activity. */
function toMeasurement(parsed) {
  return {
    executionTimeMs: parsed.durationMillis,
    documentsExamined: parsed.docsExamined,
    documentsReturned: parsed.nreturned,
    keysExamined: parsed.keysExamined,
    planStage: parsed.planStage,
    indexUsed: parsed.indexUsed,
  };
}

/** Everything the analyse endpoint answers with. */
function analyze(op) {
  const parsed = parseOp(op);
  return {
    namespace: parsed.namespace,
    databaseName: parsed.databaseName,
    collectionName: parsed.collectionName,
    operation: parsed.operation,
    subject: describe(parsed),
    queryHash: parsed.queryHash,
    metrics: {
      durationMillis: parsed.durationMillis,
      planningMillis: parsed.planningMillis,
      planningShare: parsed.durationMillis
        ? Math.round((parsed.planningMillis / parsed.durationMillis) * 1000) / 10
        : null,
      keysExamined: parsed.keysExamined,
      docsExamined: parsed.docsExamined,
      nreturned: parsed.nreturned,
      examinedPerReturned: parsed.nreturned
        ? Math.round(parsed.docsExamined / parsed.nreturned)
        : null,
      bytesRead: parsed.bytesRead,
      readMillis: parsed.readMillis,
      cpuMillis: parsed.cpuMillis,
      numYields: parsed.numYields,
      peakMemBytes: parsed.peakMemBytes,
    },
    plan: {
      summary: parsed.planSummary,
      stage: parsed.planStage,
      indexFields: parsed.indexFields,
      fromMultiPlanner: parsed.fromMultiPlanner,
    },
    findings: findings(parsed),
    recommendedIndex: recommendIndex(parsed),
    before: toMeasurement(parsed),
  };
}

module.exports = {
  parseOp,
  analyze,
  describe,
  findings,
  recommendIndex,
  toMeasurement,
  classifyPredicates,
  parsePlanSummary,
};
