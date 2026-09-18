'use strict';

const { activeCluster, activeDataConnection } = require('../config/clusterConnections');
const ApiError = require('../utils/ApiError');

/**
 * What the MongoDB server is doing right now.
 *
 * Read-only, and only two commands: `serverStatus` and `hostInfo`. Nothing here
 * writes, and nothing here reads application data — a monitor that could change
 * the thing it watches is worse than no monitor.
 *
 * The important idea is that serverStatus reports COUNTERS, not rates. `network
 * .bytesIn` is every byte since the process started; on a server up for three
 * weeks it is a number nobody can read and which barely moves between two
 * samples. What an operator actually wants is the slope: bytes per second right
 * now, operations per second right now, microseconds per operation right now.
 *
 * A slope needs two points, so the last sample per cluster is kept here and
 * each request is differenced against it. That is deliberately the server's job
 * rather than the page's:
 *
 *   - The rate is then correct however often the page polls, and stays correct
 *     when a tab is backgrounded and the browser stops firing timers.
 *   - Two people watching the same cluster see the same figures.
 *   - A counter that went backwards means the server restarted underneath us.
 *     That is detectable here, by comparing uptime, and is reported as a gap
 *     rather than as a wild negative spike.
 *
 * What cannot be read is said so, never guessed. CPU comes from
 * `systemMetrics`, which mongod only collects on Linux and which managed
 * platforms such as Atlas do not expose at all; when it is absent the field is
 * null with a reason beside it, because an invented CPU figure on a monitoring
 * page is worse than a blank one.
 */

// A sample older than this is too stale to difference: over a long gap the
// average it produces describes a period nobody was watching, and presenting
// that as "right now" would be a lie. A fresh baseline is taken instead.
const MAX_SAMPLE_AGE_MS = 5 * 60 * 1000;

// serverStatus is cheap but not free, and a monitor page polls. This is the
// floor between two real reads of one cluster; a request inside it is answered
// from the last snapshot, which is what the previous caller just computed.
const MIN_INTERVAL_MS = 900;

const COMMAND_TIMEOUT_MS = 8000;

/** The last raw sample per cluster, and the last answer computed from it. */
const samples = new Map(); // cluster key -> { at, uptime, counters }
const snapshots = new Map(); // cluster key -> { at, payload }

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

/** A rate per second between two counter readings, or null when it cannot be one. */
function perSecond(current, previous, elapsedMs) {
  if (current === null || previous === null || !elapsedMs) return null;
  const delta = current - previous;
  // A counter that went down did not go down: the process restarted, or the
  // read landed on another member of the set. Either way there is no rate to
  // report for this interval.
  if (delta < 0) return null;
  return (delta / elapsedMs) * 1000;
}

/**
 * The counters this page is built on, pulled out of serverStatus.
 *
 * Kept as plain numbers rather than the nested document so that differencing
 * two samples is a subtraction and not a tree walk, and so a server that omits
 * a section (a mongos, an old build, a locked-down managed host) produces nulls
 * instead of a crash on an undefined property.
 */
function readCounters(status) {
  const cpu = status.systemMetrics?.cpu || null;
  return {
    opcounters: {
      query: num(status.opcounters?.query),
      insert: num(status.opcounters?.insert),
      update: num(status.opcounters?.update),
      delete: num(status.opcounters?.delete),
      getmore: num(status.opcounters?.getmore),
      command: num(status.opcounters?.command),
    },
    network: {
      bytesIn: num(status.network?.bytesIn),
      bytesOut: num(status.network?.bytesOut),
      numRequests: num(status.network?.numRequests),
    },
    // Cumulative microseconds and operation counts. Dividing one delta by the
    // other gives the average latency of the operations served since the last
    // sample — not the all-time average, which is what the raw fields hold and
    // which stops moving on a long-lived server.
    latency: {
      readsLatency: num(status.opLatencies?.reads?.latency),
      readsOps: num(status.opLatencies?.reads?.ops),
      writesLatency: num(status.opLatencies?.writes?.latency),
      writesOps: num(status.opLatencies?.writes?.ops),
      commandsLatency: num(status.opLatencies?.commands?.latency),
      commandsOps: num(status.opLatencies?.commands?.ops),
    },
    // Linux-only, and absent on managed platforms. Milliseconds of CPU time,
    // which become a percentage once divided by wall time and core count.
    cpu: cpu
      ? {
          user: num(cpu.user_ms),
          system: num(cpu.system_ms),
          iowait: num(cpu.iowait_ms),
          nice: num(cpu.nice_ms),
          steal: num(cpu.steal_ms),
        }
      : null,
  };
}

/** The part of the answer that is a level rather than a rate — true as read. */
function readGauges(status, host) {
  const cache = status.wiredTiger?.cache || null;
  const cacheUsed = num(cache?.['bytes currently in the cache']);
  const cacheMax = num(cache?.['maximum bytes configured']);
  const residentMb = num(status.mem?.resident);
  const totalMb = num(host?.system?.memSizeMB);

  return {
    connections: {
      current: num(status.connections?.current),
      available: num(status.connections?.available),
      active: num(status.connections?.active),
      totalCreated: num(status.connections?.totalCreated),
      // `available` is what is left of the server's own cap, so the cap itself
      // is the pair added together. Shown as a limit because "482 of 51,200" is
      // the question an operator is really asking of this number.
      limit:
        num(status.connections?.current) !== null && num(status.connections?.available) !== null
          ? num(status.connections.current) + num(status.connections.available)
          : null,
    },
    memory: {
      residentMb,
      virtualMb: num(status.mem?.virtual),
      totalMb,
      // Resident set against physical RAM. On a shared or managed host the
      // total is not reported, and then there is no percentage to give.
      usedPercent: residentMb !== null && totalMb ? (residentMb / totalMb) * 100 : null,
      cacheUsedBytes: cacheUsed,
      cacheMaxBytes: cacheMax,
      cachePercent: cacheUsed !== null && cacheMax ? (cacheUsed / cacheMax) * 100 : null,
      pageFaults: num(status.extra_info?.page_faults),
    },
    // Queued and active work at this instant — the reading that says whether
    // the server is merely busy or actually behind.
    activity: {
      activeReaders: num(status.globalLock?.activeClients?.readers),
      activeWriters: num(status.globalLock?.activeClients?.writers),
      queuedReaders: num(status.globalLock?.currentQueue?.readers),
      queuedWriters: num(status.globalLock?.currentQueue?.writers),
    },
  };
}

/** CPU as a percentage of the host's total capacity, or null with the reason. */
function cpuBetween(current, previous, elapsedMs, cores) {
  if (!current) {
    return {
      percent: null,
      cores,
      unavailable:
        'This server does not report CPU time. mongod collects it on Linux only, and managed ' +
        'platforms such as Atlas do not expose it — read CPU from the platform’s own metrics.',
    };
  }
  if (!previous || !elapsedMs) return { percent: null, cores, unavailable: null };

  // Everything the kernel counted as this process being on-CPU. iowait is left
  // out on purpose: it is time waiting for the disk, not time computing, and
  // counting it as CPU makes a storage problem look like a CPU problem.
  const busy = ['user', 'system', 'nice', 'steal'].reduce((sum, key) => {
    const delta = perSecond(current[key], previous[key], elapsedMs);
    return delta === null ? sum : sum + delta;
  }, 0);

  // `busy` is CPU-milliseconds per second; a single core can supply 1000 of
  // them, so the whole host can supply 1000 × cores.
  const capacity = 1000 * (cores || 1);
  return { percent: Math.min((busy / capacity) * 100, 100), cores, unavailable: null };
}

/** Ask the server about itself. hostInfo is optional — it is often not granted. */
async function readServer() {
  const client = activeDataConnection()?.getClient();
  if (!client) throw new ApiError(503, 'Database connection is not ready');
  const admin = client.db('admin');

  let status;
  try {
    status = await withTimeout(admin.command({ serverStatus: 1 }), COMMAND_TIMEOUT_MS, 'serverStatus');
  } catch (err) {
    if (err.code === 13 || /not authorized|Unauthorized/i.test(err.message || '')) {
      throw ApiError.forbidden(
        'This connection may not read server statistics. The user needs the clusterMonitor role ' +
          '(on Atlas: a database user with "Only read any database" plus monitoring, or the built-in ' +
          'clusterMonitor role) before this page can show anything.'
      );
    }
    throw new ApiError(503, `Could not read serverStatus: ${err.message}`);
  }

  // Cores and physical RAM, which serverStatus does not carry. Failing to read
  // it costs a percentage, not the page, so it is never allowed to throw.
  const host = await withTimeout(admin.command({ hostInfo: 1 }), COMMAND_TIMEOUT_MS, 'hostInfo').catch(
    () => null
  );

  return { status, host };
}

/**
 * One reading of the cluster in session, with rates where a previous reading
 * allows one.
 *
 * `rates` is null on the first call for a cluster and after a long gap or a
 * server restart — there is genuinely nothing to compare against yet, and the
 * page is told that rather than shown zeroes.
 */
async function getLive({ force = false } = {}) {
  const cluster = activeCluster();
  const key = cluster?.key || '__default__';
  const now = Date.now();

  // A page polling faster than the floor, or several people watching at once,
  // gets the snapshot the last real read produced. Differencing two samples
  // taken milliseconds apart would produce noise, not a smaller interval.
  const cached = snapshots.get(key);
  if (!force && cached && now - cached.at < MIN_INTERVAL_MS) {
    return { ...cached.payload, cached: true };
  }

  const { status, host } = await readServer();
  const at = Date.now();
  const counters = readCounters(status);
  const uptime = num(status.uptime);

  const previous = samples.get(key);
  const elapsedMs = previous ? at - previous.at : 0;
  // Two reasons a previous sample cannot be differenced: it is too old to
  // describe "now", or the server restarted since (uptime went backwards), in
  // which case every counter reset to zero and a subtraction would be fiction.
  const restarted =
    previous && uptime !== null && previous.uptime !== null && uptime < previous.uptime;
  const comparable = Boolean(previous) && !restarted && elapsedMs > 0 && elapsedMs <= MAX_SAMPLE_AGE_MS;

  const rates = comparable ? buildRates(counters, previous.counters, elapsedMs) : null;

  const payload = {
    cluster: cluster ? { key: cluster.key, label: cluster.label } : null,
    server: {
      host: status.host || null,
      version: status.version || null,
      process: status.process || null,
      // A mongos has no storage engine of its own, and a monitor should say so
      // rather than show empty memory figures as if they were zero.
      storageEngine: status.storageEngine?.name || null,
      uptimeSeconds: uptime,
      startedAt: uptime !== null ? new Date(at - uptime * 1000).toISOString() : null,
      localTime: status.localTime ? new Date(status.localTime).toISOString() : null,
    },
    ...readGauges(status, host),
    cpu: cpuBetween(counters.cpu, comparable ? previous.counters.cpu : null, elapsedMs, num(host?.system?.numCores)),
    rates,
    sample: {
      at: new Date(at).toISOString(),
      // How wide the window behind `rates` is. A reader can tell a figure
      // averaged over two seconds from one averaged over two minutes.
      intervalMs: comparable ? elapsedMs : null,
      // Why there are no rates this time, in the page's own words.
      baseline: rates
        ? null
        : restarted
          ? 'The server restarted since the last reading, so its counters began again. Rates resume from the next sample.'
          : previous
            ? 'Too long since the last reading to average over. Rates resume from the next sample.'
            : 'First reading — rates need two, so they appear from the next sample.',
    },
  };

  samples.set(key, { at, uptime, counters });
  snapshots.set(key, { at, payload });
  return payload;
}

/** Every per-second figure the page shows, from two counter readings. */
function buildRates(current, previous, elapsedMs) {
  const ops = {};
  for (const name of Object.keys(current.opcounters)) {
    ops[name] = perSecond(current.opcounters[name], previous.opcounters[name], elapsedMs);
  }
  const total = Object.values(ops).reduce((sum, v) => (v === null ? sum : sum + v), 0);

  // Average microseconds per operation over this window: the latency delta
  // divided by the operation delta. Dividing the raw cumulative fields instead
  // would give the average since the process started, which on a long-lived
  // server no longer moves however slow things get right now.
  const latencyOf = (latencyKey, opsKey) => {
    const latencyDelta = current.latency[latencyKey] - previous.latency[latencyKey];
    const opsDelta = current.latency[opsKey] - previous.latency[opsKey];
    if (!Number.isFinite(latencyDelta) || !Number.isFinite(opsDelta)) return null;
    if (latencyDelta < 0 || opsDelta < 0) return null;
    // No operations of this kind in the window. That is not "zero latency" —
    // there is nothing to report, and a zero on the chart would read as fast.
    if (opsDelta === 0) return null;
    return latencyDelta / opsDelta / 1000; // microseconds → milliseconds
  };

  return {
    operationsPerSecond: { ...ops, total },
    network: {
      bytesInPerSecond: perSecond(current.network.bytesIn, previous.network.bytesIn, elapsedMs),
      bytesOutPerSecond: perSecond(current.network.bytesOut, previous.network.bytesOut, elapsedMs),
      requestsPerSecond: perSecond(current.network.numRequests, previous.network.numRequests, elapsedMs),
    },
    latencyMs: {
      reads: latencyOf('readsLatency', 'readsOps'),
      writes: latencyOf('writesLatency', 'writesOps'),
      commands: latencyOf('commandsLatency', 'commandsOps'),
    },
  };
}

/** Forget a cluster's baseline — used by tests and when a connection is replaced. */
function reset(clusterKey) {
  if (clusterKey) {
    samples.delete(clusterKey);
    snapshots.delete(clusterKey);
    return;
  }
  samples.clear();
  snapshots.clear();
}

module.exports = { getLive, reset, MIN_INTERVAL_MS };
