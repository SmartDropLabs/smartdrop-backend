'use strict';

const config = require('../config');
const logger = require('../logger');
const priceOracle = require('../services/priceOracle');

const DEFAULT_TIMEOUT_MS = 30000;

function isWarmSuccess(result) {
  return (
    result.status === 'fulfilled' &&
    result.value &&
    result.value.price_usd !== null &&
    result.value.redis_unavailable !== true
  );
}

async function runWarmCache(assets, oracle) {
  const startedAt = Date.now();
  const results = await Promise.allSettled(
    assets.map(({ code, issuer }) => (
      Promise.resolve().then(() => oracle.fetchFreshPrice(code, issuer || null))
    ))
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

async function warmCache(
  assets = config.watchedAssets,
  oracle = priceOracle,
  { timeoutMs = DEFAULT_TIMEOUT_MS, log = logger } = {}
) {
  let allAssets = Array.isArray(assets) ? [...assets] : [];

  if (oracle && typeof oracle.getQueriedAssets === 'function') {
    try {
      const queried = await oracle.getQueriedAssets();
      const seen = new Set(allAssets.map((a) => (a.issuer ? `${a.code}:${a.issuer}` : a.code)));
      for (const item of queried) {
        const key = item.issuer ? `${item.code}:${item.issuer}` : item.code;
        if (!seen.has(key)) {
          seen.add(key);
          allAssets.push(item);
        }
      }
    } catch (err) {
      log.warn('Failed to fetch queried assets during cache warming', { error: err.message });
    }
  }

  if (!allAssets || allAssets.length === 0) {
    log.info('Cache warm skipped: no watched assets configured');
    return { total: 0, succeeded: 0, failed: 0, timedOut: false, durationMs: 0 };
  }

  let timedOut = false;
  let timeoutId;

  const warming = runWarmCache(allAssets, oracle).then((summary) => {
    if (!timedOut) {
      log.info('Cache warm complete', summary);
    }
    return summary;
  });

  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      const summary = {
        total: allAssets.length,
        succeeded: 0,
        failed: allAssets.length,
        timedOut: true,
        durationMs: timeoutMs,
      };
      log.warn('Cache warm timed out; starting server anyway', summary);
      resolve(summary);
    }, timeoutMs);
  });

  const summary = await Promise.race([warming, timeout]);
  if (!summary.timedOut) clearTimeout(timeoutId);
  return summary;
}

module.exports = {
  warmCache,
  runWarmCache,
};
