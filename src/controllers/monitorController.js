'use strict';

const monitorService = require('../services/monitorService');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');

/**
 * GET /api/monitor/live
 *
 * One reading of the cluster the session is pinned to: CPU and memory,
 * connections, operations per second, query latency and network throughput.
 *
 * Read-only, and the cluster is whichever one the session already chose — a
 * monitor that could be pointed anywhere would be a second way to reach a
 * cluster the session was never moved to.
 *
 * `?force=1` skips the short server-side floor between real reads. It is for
 * the page's own Refresh button, where somebody is waiting and a cached
 * snapshot would look like a dead button.
 */
const live = asyncHandler(async (req, res) => {
  const data = await monitorService.getLive({
    force: req.query.force === '1' || req.query.force === 'true',
  });

  return sendSuccess(res, {
    message: data.rates
      ? `Live reading of ${data.server.host || 'the server'}`
      : data.sample.baseline,
    data,
  });
});

module.exports = { live };
