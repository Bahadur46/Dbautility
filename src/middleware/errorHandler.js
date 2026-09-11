'use strict';

const mongoose = require('mongoose');
const ApiError = require('../utils/ApiError');
const { config } = require('../config/env');

/** 404 handler for unmatched routes. */
function notFoundHandler(req, res, next) {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

/** Central error handler — every thrown/forwarded error lands here. */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal server error';
  let errors = err.errors || null;

  // Mongoose schema validation
  if (err instanceof mongoose.Error.ValidationError) {
    statusCode = 400;
    message = 'Validation failed';
    errors = Object.values(err.errors).map((e) => ({
      field: e.path,
      message: e.message,
    }));
  }

  // Malformed ObjectId and friends
  if (err instanceof mongoose.Error.CastError) {
    statusCode = 400;
    message = `Invalid value for "${err.path}"`;
  }

  // Duplicate key
  if (err.code === 11000) {
    statusCode = 409;
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    message = `A record with this ${field} already exists`;
    errors = [{ field, message }];
  }

  if (statusCode >= 500) {
    // eslint-disable-next-line no-console
    console.error('[error]', err);
  }

  const body = { success: false, message };
  if (errors) body.errors = errors;
  // Opt IN to the stack, rather than out of it. `!isProduction` was true
  // whenever NODE_ENV was simply unset — so a deployment that forgot one
  // environment variable returned absolute server paths and the module
  // layout to any caller who could provoke a 500.
  if (config.nodeEnv === 'development' && statusCode >= 500) body.stack = err.stack;

  res.status(statusCode).json(body);
}

module.exports = { notFoundHandler, errorHandler };
