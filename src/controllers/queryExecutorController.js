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
 * Administrator only: this creates or removes an index outside the register —
 * a drop may take one something else still depends on, and a create writes to
 * a production collection without a definition behind it. There is no "unused"
 * or "this query needs it" evidence behind either request — the operator is
 * asserting it, so the account making the assertion has to be one that carries
 * the responsibility.
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

  const result = await queryExecutor.execute({ command, reason: req.body?.reason, user: req.user, req });

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
  const changes = queryExecutor.WRITES.includes(parsed.operation);

  const messages = {
    createIndex: 'This command creates an index. It will be recorded as a CREATE audit entry.',
    dropIndex: 'This command removes an index. It will be recorded as a DROP audit entry.',
  };

  return sendSuccess(res, {
    message: messages[parsed.operation] || 'This command only reads. Nothing will be changed or recorded.',
    data: { ...parsed, changes },
  });
});

module.exports = { runCommand, previewCommand };
