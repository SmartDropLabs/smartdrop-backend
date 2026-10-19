'use strict';

const config = require('../config');
const logger = require('../logger');
const priceOracle = require('../services/priceOracle');
const cache = require('../services/cache');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_ENTRY_TIMEOUT_MS = 10000;
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_LOCK_TTL_MS = 60000;
const WARM_LOCK_KEY = 'cache:warm:lock';

// Issue #495 — startup cache warming used to be awaited before app.listen(),
// so a slow upstream held the port closed for up to `timeoutMs` and every
// replica of a fleet hammered the price sources at the same instant. Warming
// is now fired in the background (the server accepts traffic immediately),
// bounded in breadth (maxEntries), in parallelism (concurrency), per call
// (entryTimeoutMs) and overall (timeoutMs), guarded by a Redis lock so only
// one replica warms at a time, and observable via getWarmStatus().
const warmStatus = {
  state: 'idle',
  enabled: true,
  reason: null,
  lockSkipped: false,
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  summary: null,
  error: null,
};

function isWarmSuccess(result) {
  return (
    result.status === 'fulfilled' &&
    result.value &&
    result.value.price_usd !== null &&
    result.value.redis_unavailable !== true
  );
}

function assetKey(asset) {
  return asset.issuer ? `${asset.code}:${asset.issuer}` : asset.code;
}

async function collectAssets(assets, oracle, log) {
  const all = Array.isArray(assets) ? [...assets] : [];

  if (oracle && typeof oracle.getQueriedAssets === 'function') {
    try {
      const queried = await oracle.getQueriedAssets();
      const seen = new Set(all.map(assetKey));
      for (const item of queried) {
        const key = assetKey(item);
        if (!seen.has(key)) {
          seen.add(key);
          all.push(item);
        }
      }
    } catch (err) {
      log.warn('Failed to fetch queried assets during cache warming', { error: err.message });
    }
  }

  return all;
}

/**
 * Wrap a single oracle fetch with its own timeout so one hung upstream cannot
 * consume the whole warming budget. Resolves (never rejects) to a
 * settled-style result so the caller can count it uniformly.
 */
function fetchAssetWithTimeout(asset, oracle, entryTimeoutMs, abortSignal, timers) {
  return new Promise((resolve) => {
    if (abortSignal && abortSignal.aborted) {
      resolve({ status: 'rejected', reason: new Error('Warming cancelled') });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      timers.delete(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ status: 'rejected', reason: new Error(`Price fetch timed out after ${entryTimeoutMs}ms`) });
    }, entryTimeoutMs);
    timers.add(timer);

    Promise.resolve()
      .then(() => oracle.fetchFreshPrice(asset.code, asset.issuer || null))
      .then(
        (value) => finish({ status: 'fulfilled', value }),
        (reason) => finish({ status: 'rejected', reason })
      );
  });
}

/**
 * Run fetches with a bounded worker pool: at most `concurrency` requests are
 * in flight at once, but no more than `assets.length`. Returns the settled
 * results (order of completion, not of input).
 */
async function runWarmPool(assets, oracle, { entryTimeoutMs, concurrency, abortSignal, timers, log }) {
  const queue = [...assets];
  const results = [];
  const workerCount = Math.max(1, Math.min(concurrency, queue.length));

  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length > 0) {
      const asset = queue.shift();
      results.push(await fetchAssetWithTimeout(asset, oracle, entryTimeoutMs, abortSignal, timers));
    }
  });

  await Promise.all(workers);
  if (timers.size > 0 && log) {
    // Defensive: nothing should remain once every worker has drained.
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }
  return results;
}

/**
 * Warm the price cache once, returning a summary.
 *
 * The signature is unchanged from before #495 (`assets`, `oracle`,
 * `{ timeoutMs, log }`); the extra options (entryTimeoutMs, maxEntries,
 * concurrency) are optional and default to the configured bounds.
 */
async function warmCache(
  assets = config.watchedAssets,
  oracle = priceOracle,
  options = {}
) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    entryTimeoutMs = DEFAULT_ENTRY_TIMEOUT_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    concurrency = DEFAULT_CONCURRENCY,
    log = logger,
  } = options;

  let allAssets = await collectAssets(assets, oracle, log);

  if (!allAssets || allAssets.length === 0) {
    log.info('Cache warm skipped: no watched assets configured');
    return { total: 0, succeeded: 0, failed: 0, timedOut: false, durationMs: 0 };
  }

  if (Number.isFinite(maxEntries) && maxEntries > 0 && allAssets.length > maxEntries) {
    const dropped = allAssets.length - maxEntries;
    allAssets = allAssets.slice(0, maxEntries);
    log.warn('Cache warm asset list truncated', {
      max_entries: maxEntries,
      dropped,
    });
  }

  const abortController = new AbortController();
  const timers = new Set();
  let timedOut = false;
  let timeoutId;

  // Results fill in as workers finish, so the overall timeout can snapshot the
  // successes achieved so far instead of hardcoding 0 (#413).
  const results = [];
  const warming = runWarmPool(allAssets, oracle, {
    entryTimeoutMs,
    concurrency,
    abortSignal: abortController.signal,
    timers,
    log,
  }).then((settled) => {
    results.push(...settled);
    const succeeded = results.filter(isWarmSuccess).length;
    return {
      total: allAssets.length,
      succeeded,
      failed: allAssets.length - succeeded,
      timedOut: false,
      durationMs: 0,
    };
  });

  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      // Signal abort to cancel in-flight fetches (#402)
      abortController.abort();
      const succeeded = results.filter(isWarmSuccess).length;
      const summary = {
        total: allAssets.length,
        succeeded,
        failed: allAssets.length - succeeded,
        timedOut: true,
        durationMs: timeoutMs,
      };
      log.warn('Cache warm timed out; starting server anyway', summary);
      resolve(summary);
    }, timeoutMs);
  });

  const summary = await Promise.race([warming, timeout]);
  clearTimeout(timeoutId);
  for (const timer of timers) clearTimeout(timer);
  timers.clear();

  if (!summary.timedOut) {
    // One completion line per startup (mirroring the timeout path's warn)
    // so an operator can see how much of the cache actually warmed without
    // diffing per-asset fetch logs.
    log.info('Cache warm complete', summary);
  }
  return summary;
}

/**
 * Backwards-compatible helper retained from before #495. Not used by the
 * startup path any more (see warmCacheInBackground); kept so any external
 * caller importing it keeps working.
 */
async function runWarmCache(assets, oracle, abortSignal) {
  const startedAt = Date.now();
  const results = await Promise.allSettled(
    assets.map(({ code, issuer }) => {
      if (abortSignal && abortSignal.aborted) {
        return Promise.reject(new Error('Warming cancelled'));
      }
      return Promise.resolve().then(() => oracle.fetchFreshPrice(code, issuer || null));
    })
  );
  const succeeded = results.filter(isWarmSuccess).length;

  return {
    total: assets.length,
    succeeded,
    failed: assets.length - succeeded,
    timedOut: false,
    durationMs: Date.now() - startedAt,
  };
}

function delay(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * Best-effort release of the warming lock. Compare-and-delete so we never
 * delete a lock another replica has since acquired (our key may have expired
 * mid-warm if the TTL was too small for a slow warm).
 */
async function releaseLock(redis, key, owner) {
  if (!redis || typeof redis.get !== 'function') return;
  try {
    const current = await redis.get(key);
    if (current === owner) await redis.del(key);
  } catch (err) {
    // Lock release is best-effort; the TTL will clean up.
  }
}

/**
 * Warm the cache in the background, without blocking startup (issue #495).
 *
 * Returns a promise that resolves once warming is done (or skipped), so
 * callers/tests can await it — the process does not await it on the startup
 * path. Never rejects.
 *
 * Only one replica warms at a time: the winner takes a short Redis lock
 * (`SET ... NX PX`). Losers record a `locked` status and return.
 */
async function warmCacheInBackground({
  assets = config.watchedAssets,
  oracle = priceOracle,
  log = logger,
  cacheModule = cache,
  enabled = config.cacheWarm ? config.cacheWarm.enabled : true,
  timeoutMs,
  entryTimeoutMs,
  maxEntries,
  concurrency,
  jitterMs,
  lockTtlMs = config.cacheWarm ? config.cacheWarm.lockTtlMs : DEFAULT_LOCK_TTL_MS,
  lockKey = WARM_LOCK_KEY,
} = {}) {
  warmStatus.enabled = enabled;
  warmStatus.reason = null;
  warmStatus.lockSkipped = false;

  if (!enabled) {
    warmStatus.state = 'disabled';
    log.info('Cache warm disabled via CACHE_WARM_ENABLED');
    return { skipped: true, reason: 'disabled' };
  }

  const owner = `${config.leaderElection.instanceId}:${Date.now()}`;
  let redis = null;
  let locked = false;

  try {
    redis = cacheModule.getClient();
    if (redis && typeof redis.set === 'function') {
      const ttl = lockTtlMs > 0 ? lockTtlMs : DEFAULT_LOCK_TTL_MS;
      const result = await redis.set(lockKey, owner, 'PX', ttl, 'NX');
      locked = result === 'OK';
    } else {
      // No Redis client available (degraded boot) — warm anyway rather than
      // skip warming entirely; the lock is an optimisation, not a
      // correctness requirement.
      locked = true;
    }
  } catch (err) {
    log.warn('Could not acquire cache warm lock; warming without it', { error: err.message });
    locked = true;
  }

  if (!locked) {
    warmStatus.state = 'locked';
    warmStatus.lockSkipped = true;
    warmStatus.reason = 'lock_held';
    log.info('Cache warm skipped: another instance holds the warm lock', { lock_key: lockKey });
    return { skipped: true, reason: 'lock_held' };
  }

  warmStatus.state = 'running';
  warmStatus.startedAt = Date.now();
  warmStatus.finishedAt = null;
  warmStatus.durationMs = null;
  warmStatus.summary = null;
  warmStatus.error = null;

  try {
    // Stagger replicas that start together (fleet rollout) — jitter is
    // applied while holding the lock so only the winner is delayed.
    await delay(jitterMs || (config.cacheWarm && config.cacheWarm.jitterMs));

    const summary = await warmCache(assets, oracle, {
      log,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(entryTimeoutMs !== undefined ? { entryTimeoutMs } : {}),
      ...(maxEntries !== undefined ? { maxEntries } : {}),
      ...(concurrency !== undefined ? { concurrency } : {}),
    });

    warmStatus.state = 'completed';
    warmStatus.summary = summary;
    return summary;
  } catch (err) {
    warmStatus.state = 'failed';
    warmStatus.error = err.message;
    log.warn('Cache warm failed; starting server anyway', { error: err.message });
    return { skipped: false, error: err.message };
  } finally {
    warmStatus.finishedAt = Date.now();
    warmStatus.durationMs = warmStatus.finishedAt - warmStatus.startedAt;
    await releaseLock(redis, lockKey, owner);
  }
}

/**
 * Snapshot of the last warm attempt, surfaced on GET /health (never on
 * /ready — warming is an optimisation, not a dependency).
 */
function getWarmStatus() {
  return {
    state: warmStatus.state,
    enabled: warmStatus.enabled,
    reason: warmStatus.reason,
    lock_skipped: warmStatus.lockSkipped,
    started_at: warmStatus.startedAt ? new Date(warmStatus.startedAt).toISOString() : null,
    finished_at: warmStatus.finishedAt ? new Date(warmStatus.finishedAt).toISOString() : null,
    duration_ms: warmStatus.durationMs,
    summary: warmStatus.summary,
    error: warmStatus.error,
  };
}

// Test-only: reset the module-level status between cases.
function _resetWarmStatus(overrides = {}) {
  warmStatus.state = 'idle';
  warmStatus.enabled = true;
  warmStatus.reason = null;
  warmStatus.lockSkipped = false;
  warmStatus.startedAt = null;
  warmStatus.finishedAt = null;
  warmStatus.durationMs = null;
  warmStatus.summary = null;
  warmStatus.error = null;
  Object.assign(warmStatus, overrides);
}

module.exports = {
  warmCache,
  warmCacheInBackground,
  getWarmStatus,
  runWarmCache,
  WARM_LOCK_KEY,
  _resetWarmStatus,
};
