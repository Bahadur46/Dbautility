'use strict';

/**
 * Validation for Manual Index definitions.
 *
 * The rules here mirror what MongoDB itself will accept, so a definition is
 * rejected with a clear field-level message before `createIndex()` is ever
 * called with something the server would refuse.
 */

const INDEX_TYPES = [
  'SINGLE',
  'COMPOUND',
  'UNIQUE',
  'PARTIAL',
  'TTL',
  'TEXT',
  'HASHED',
  'WILDCARD',
  'GEO2DSPHERE',
  'GEO2D',
];

const STATUSES = ['ACTIVE', 'INACTIVE', 'DRAFT'];

// Values a single key may take. Numbers order the key; the rest select a
// specialised index implementation for that field.
const DIRECTIONS = ['1', '-1', 'text', 'hashed', '2dsphere', '2d'];

/** The key direction each specialised type requires. */
const REQUIRED_DIRECTION = {
  TEXT: 'text',
  HASHED: 'hashed',
  GEO2DSPHERE: '2dsphere',
  GEO2D: '2d',
};

/** Types whose key must be an ordinary ascending/descending field. */
const ORDERED_TYPES = ['SINGLE', 'COMPOUND', 'UNIQUE', 'PARTIAL', 'TTL', 'WILDCARD'];

/** Comparison operators offered by the condition builder. */
const CONDITION_OPERATORS = ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists', '$type'];

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

/**
 * Parse a partial-filter expression that may arrive as an object or as JSON
 * text from a form field. Returns { value, error }.
 */
function parseFilterExpression(raw) {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  if (typeof raw === 'object') {
    if (Array.isArray(raw)) return { error: 'Partial filter expression must be a JSON object, not an array' };
    return { value: raw };
  }
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'Partial filter expression must be a JSON object' };
    }
    return { value: parsed };
  } catch {
    return { error: 'Partial filter expression is not valid JSON' };
  }
}

/**
 * MongoDB only supports a restricted set of operators inside a
 * partialFilterExpression. Anything else makes createIndex fail, so it is
 * caught here with an explanation instead.
 */
const PARTIAL_ALLOWED = new Set(['$eq', '$exists', '$gt', '$gte', '$lt', '$lte', '$type', '$and']);

function validatePartialExpression(expression, errors, field = 'options.partialFilterExpression') {
  const walk = (node, path) => {
    for (const [key, value] of Object.entries(node || {})) {
      if (key === '$and') {
        if (!Array.isArray(value)) {
          errors.push({ field, message: '$and must be an array of conditions' });
          continue;
        }
        value.forEach((sub) => walk(sub, path));
        continue;
      }
      if (key.startsWith('$')) {
        if (!PARTIAL_ALLOWED.has(key)) {
          errors.push({
            field,
            message: `MongoDB does not allow "${key}" in a partial index condition. Allowed: ${[...PARTIAL_ALLOWED].join(', ')}`,
          });
        }
        continue;
      }
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const operators = Object.keys(value).filter((k) => k.startsWith('$'));
        for (const op of operators) {
          if (!PARTIAL_ALLOWED.has(op)) {
            errors.push({
              field,
              message: `MongoDB does not allow "${op}" in a partial index condition (used on "${key}"). Allowed: ${[...PARTIAL_ALLOWED].join(', ')}`,
            });
          }
        }
      }
    }
  };
  walk(expression, '');
}

/** Is this a wildcard key path, e.g. "$**" or "userMeta.$**"? */
const isWildcardPath = (field) => field === '$**' || /^[A-Za-z_][A-Za-z0-9_.]*\.\$\*\*$/.test(field);

/** Validate the index key list — the part that becomes the real MongoDB key spec. */
function validateKeys(keys, indexType, errors) {
  if (!Array.isArray(keys) || keys.length === 0) {
    errors.push({ field: 'keys', message: 'At least one index key field is required' });
    return;
  }

  if (keys.length > 32) {
    errors.push({ field: 'keys', message: 'A MongoDB index may not have more than 32 key fields' });
  }

  const required = REQUIRED_DIRECTION[indexType];
  const seen = new Set();

  keys.forEach((key, i) => {
    const field = key && key.field !== undefined ? String(key.field).trim() : '';
    const direction = key && key.direction !== undefined ? String(key.direction) : '1';

    if (!field) {
      errors.push({ field: `keys[${i}].field`, message: 'Field name is required' });
    } else if (indexType === 'WILDCARD') {
      if (!isWildcardPath(field)) {
        errors.push({
          field: `keys[${i}].field`,
          message: 'A wildcard index key must be "$**" (all fields) or "path.$**" (one subtree)',
        });
      }
    } else if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(field)) {
      errors.push({
        field: `keys[${i}].field`,
        message: 'Field name must start with a letter or underscore and contain only letters, numbers, dots and underscores',
      });
    }

    if (field) {
      if (seen.has(field)) {
        errors.push({ field: `keys[${i}].field`, message: `Field "${field}" is listed more than once` });
      }
      seen.add(field);
    }

    if (!DIRECTIONS.includes(direction)) {
      errors.push({
        field: `keys[${i}].direction`,
        message: `Direction must be one of: ${DIRECTIONS.join(', ')}`,
      });
      return;
    }

    if (required && direction !== required) {
      errors.push({
        field: `keys[${i}].direction`,
        message: `A ${indexType} index requires every key to use direction "${required}"`,
      });
    }
    if (!required && ORDERED_TYPES.includes(indexType) && !['1', '-1'].includes(direction)) {
      errors.push({
        field: `keys[${i}].direction`,
        message: `Direction "${direction}" is not allowed on a ${indexType} index — use 1 or -1`,
      });
    }
  });

  // Per-type shape rules.
  if (indexType === 'SINGLE' && keys.length !== 1) {
    errors.push({ field: 'keys', message: 'A SINGLE index must have exactly one key field' });
  }
  if (indexType === 'COMPOUND' && keys.length < 2) {
    errors.push({ field: 'keys', message: 'A COMPOUND index must have at least two key fields' });
  }
  if (indexType === 'TTL' && keys.length !== 1) {
    errors.push({ field: 'keys', message: 'A TTL index must have exactly one key field (a date field)' });
  }
  if (indexType === 'HASHED' && keys.length !== 1) {
    errors.push({ field: 'keys', message: 'A HASHED index must have exactly one key field' });
  }
  if (indexType === 'WILDCARD' && keys.length !== 1) {
    errors.push({ field: 'keys', message: 'A WILDCARD index must have exactly one key' });
  }
  if (indexType === 'GEO2D' && keys.length !== 1) {
    errors.push({ field: 'keys', message: 'A 2d index must have exactly one key field' });
  }
}

function validateCommon(body, { requireName }) {
  const errors = [];

  if (requireName || body.indexName !== undefined) {
    if (isBlank(body.indexName)) {
      errors.push({ field: 'indexName', message: 'Index name is required' });
    } else {
      const name = String(body.indexName).trim();
      if (name.length < 3 || name.length > 120) {
        errors.push({ field: 'indexName', message: 'Index name must be between 3 and 120 characters' });
      }
      if (!/^[A-Za-z0-9_.\-]+$/.test(name)) {
        errors.push({
          field: 'indexName',
          message: 'Index name may only contain letters, numbers, dots, hyphens and underscores (no spaces — it becomes the real MongoDB index name)',
        });
      }
    }
  }

  if (requireName || body.collectionName !== undefined) {
    if (isBlank(body.collectionName)) {
      errors.push({ field: 'collectionName', message: 'Collection name is required — the index is created on this collection' });
    } else {
      const c = String(body.collectionName).trim();
      if (c.length > 120) {
        errors.push({ field: 'collectionName', message: 'Collection name must be at most 120 characters' });
      }
      if (!/^[A-Za-z_][A-Za-z0-9_.\-]*$/.test(c)) {
        errors.push({ field: 'collectionName', message: 'Invalid collection name' });
      }
      if (c.startsWith('system.')) {
        errors.push({ field: 'collectionName', message: 'System collections cannot be modified' });
      }
    }
  }

  if (!isBlank(body.databaseName)) {
    const d = String(body.databaseName).trim();
    if (d.length > 80) {
      errors.push({ field: 'databaseName', message: 'Database name must be at most 80 characters' });
    }
    if (/[\s\\/."$*<>:|?]/.test(d)) {
      errors.push({ field: 'databaseName', message: 'Database name contains characters MongoDB does not allow' });
    }
    if (['admin', 'local', 'config'].includes(d)) {
      errors.push({ field: 'databaseName', message: 'Reserved databases cannot be modified' });
    }
  }

  const indexType = body.indexType || 'SINGLE';
  if (!INDEX_TYPES.includes(indexType)) {
    errors.push({ field: 'indexType', message: `Index type must be one of: ${INDEX_TYPES.join(', ')}` });
  }

  if (!isBlank(body.status) && !STATUSES.includes(body.status)) {
    errors.push({ field: 'status', message: `Status must be one of: ${STATUSES.join(', ')}` });
  }

  if (!isBlank(body.description) && String(body.description).trim().length > 1000) {
    errors.push({ field: 'description', message: 'Description must be at most 1000 characters' });
  }

  if (requireName || body.keys !== undefined) {
    validateKeys(body.keys, indexType, errors);
  }

  const options = body.options || {};

  if (indexType === 'TTL') {
    const secs = options.expireAfterSeconds;
    if (secs === undefined || secs === null || secs === '') {
      errors.push({ field: 'options.expireAfterSeconds', message: 'A TTL index requires expireAfterSeconds' });
    } else if (!Number.isFinite(Number(secs)) || Number(secs) < 0) {
      errors.push({ field: 'options.expireAfterSeconds', message: 'expireAfterSeconds must be a number of seconds, 0 or greater' });
    }
  }

  // A partial condition is OPTIONAL on every index type — MongoDB treats it as
  // an option, not a kind of index. The PARTIAL type simply requires one.
  const { value: partial, error: partialError } = parseFilterExpression(options.partialFilterExpression);
  if (partialError) {
    errors.push({ field: 'options.partialFilterExpression', message: partialError });
  } else if (partial && Object.keys(partial).length > 0) {
    validatePartialExpression(partial, errors);
    if (indexType === 'TEXT') {
      errors.push({
        field: 'options.partialFilterExpression',
        message: 'MongoDB does not allow a partial condition on a TEXT index',
      });
    }
    if (options.sparse) {
      errors.push({
        field: 'options.partialFilterExpression',
        message: 'MongoDB does not allow a partial condition together with sparse — use one or the other',
      });
    }
  } else if (indexType === 'PARTIAL') {
    errors.push({
      field: 'options.partialFilterExpression',
      message: 'A PARTIAL index requires a condition, e.g. {"status": {"$ne": "paid"}}',
    });
  }

  return errors;
}

const validateCreate = (body) => validateCommon(body, { requireName: true });
const validateUpdate = (body) => validateCommon(body, { requireName: false });

module.exports = {
  validateCreate,
  validateUpdate,
  parseFilterExpression,
  validatePartialExpression,
  INDEX_TYPES,
  STATUSES,
  DIRECTIONS,
  REQUIRED_DIRECTION,
  CONDITION_OPERATORS,
  PARTIAL_ALLOWED: [...PARTIAL_ALLOWED],
};
