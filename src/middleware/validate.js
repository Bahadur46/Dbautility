'use strict';

const mongoose = require('mongoose');
const ApiError = require('../utils/ApiError');

/**
 * Runs a validator function of the shape `(payload) => [{ field, message }]`
 * against `req[source]` and rejects the request when it returns any errors.
 */
function validate(validator, source = 'body') {
  return (req, res, next) => {
    const errors = validator(req[source] || {});
    if (errors.length) {
      return next(ApiError.badRequest('Validation failed', errors));
    }
    return next();
  };
}

/** Guard route params that must be valid Mongo ObjectIds. */
function validateObjectId(paramName = 'id') {
  return (req, res, next) => {
    const value = req.params[paramName];
    if (!mongoose.Types.ObjectId.isValid(value)) {
      return next(ApiError.badRequest(`Invalid ${paramName}: "${value}" is not a valid identifier`));
    }
    return next();
  };
}

module.exports = { validate, validateObjectId };
