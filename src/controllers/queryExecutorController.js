'use strict';

const queryExecutor = require('../services/queryExecutorService');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { sendSuccess } = require('../utils/apiResponse');

/**
 * POST /api/query-executor
 *
 * Run one pasted mongo shell index command against the cluster in session.
 *
 * Administrator only, for the same reason the analyzer's drop is: this removes
 * an index the application never created, and something else may still depend
 * on it. Unlike the analyzer there is no "unused" evidence behind the request —
 * the operator is asserting it, so the account making the assertion has to be
 * one that carries the responsibility.
 */
const runCommand = asyncHandler(async (req, res) => {
  if (!req.user.isAdmin) {
    throw ApiError.forbidden(
      'Only an administrator may run commands here. Switch to an admin user to do this.'
    );
  }

  const command = req.body?.command;
  if (!command || !String(command).trim()) {
    throw ApiError.badRequest('Validation failed', [
      { field: 'command', message: 'Paste the command you want to run' },
    ]);
  }

  const result = await queryExecutor.execute({ command, user: req.user, req });

  return sendSuccess(res, { message: result.message, data: result });
});

/**
 * POST /api/query-executor/preview
 *
 * Read the command back without running it: what it would do, where, and
 * whether it changes anything. Nothing is executed and nothing is audited, so
 * a paste can be checked before it is trusted.
 */
const previewCommand = asyncHandler(async (req, res) => {
  const parsed = queryExecutor.parseCommand(req.body?.command);

  return sendSuccess(res, {
    message:
      parsed.operation === 'dropIndex'
        ? 'This command removes an index. It will be recorded as a DROP audit entry.'
        : 'This command only reads. Nothing will be changed or recorded.',
    data: { ...parsed, changes: parsed.operation === 'dropIndex' },
  });
});

module.exports = { runCommand, previewCommand };
