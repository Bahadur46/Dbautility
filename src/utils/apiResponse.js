'use strict';

/** Uniform success envelope used by every controller. */
function sendSuccess(res, { statusCode = 200, message = 'Success', data = null, meta = null }) {
  const body = { success: true, message };
  if (data !== null) body.data = data;
  if (meta !== null) body.meta = meta;
  return res.status(statusCode).json(body);
}

/** Build pagination metadata from the query parameters and total count. */
function buildPagination({ page, limit, total }) {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
  };
}

module.exports = { sendSuccess, buildPagination };
