const cache = require('./cache');
const stellarDex = require('./sources/stellarDex');
const coingecko = require('./sources/coingecko');
const coinmarketcap = require('./sources/coinmarketcap');
const config = require('../config');
const logger = require('../logger');
const { CircuitBreaker } = require('../utils/circuitBreaker');

const CACHE_PREFIX = 'price:';
const HISTORY_PREFIX = 'price:history:';
const breakerOptions = config.price.circuitBreaker;

// In-flight de-duplication map: key -> Promise. Prevents concurrent getPrice/
// fetchFreshPrice calls for the same asset from each independently hitting all
// upstream sources (CoinGecko, CoinMarketCap, Stellar DEX) on a cache miss.
const inFlight = new Map();

const ALL_SOURCES = [
  {
    name: 'stellar_dex',
    fetch: stellarDex.fetchPrice,
    isSupported: stellarDex.isSupported,
    breaker: new CircuitBreaker('stellar_dex', breakerOptions),
  },
  {
    name: 'coingecko',
    fetch: coingecko.fetchPrice,
    isSupported: coingecko.isSupported,
    breaker: new CircuitBreaker('coingecko', breakerOptions),
    getCircuitState: coingecko.getCircuitState,
  },
  {
    name: 'coinmarketcap',
    fetch: coinmarketcap.fetchPrice,
    isSupported: coinmarketcap.isSupported,
    breaker: new CircuitBreaker('coinmarketcap', breakerOptions),
    getCircuitState: coinmarketcap.getCircuitState,
  },
];

function sortByPriority(sources, priority) {
  if (!priority || priority.length === 0) return sources;
  const order = new Map(priority.map((name, i) => [name, i]));
  return [...sources].sort((a, b) => {
    const ia = order.has(a.name) ? order.get(a.name) : Infinity;
    const ib = order.has(b.name) ? order.get(b.name) : Infinity;
    return ia - ib;
  });
}

const SOURCES = sortByPriority(ALL_SOURCES, config.price.sourcePriority);

/**
 * Circuit-breaker state for every source that has one (currently coingecko
 * and coinmarketcap — stellar_dex has no API-key/auth failure mode). Lets
 * callers (e.g. /health) see at a glance which price sources are currently
 * skipped due to a nonRetryable failure. See #95.
 */
function getSourceCircuitStates() {
  return SOURCES.filter((source) => typeof source.getCircuitState === 'function').map((source) =>
    source.getCircuitState()
  );
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function buildCacheKey(assetCode, issuer) {
  if (!issuer) return `${CACHE_PREFIX}${assetCode}`;
  return `${CACHE_PREFIX}${assetCode}:${issuer}`;
}

function buildHistoryKey(assetCode, issuer) {
  if (!issuer) return `${HISTORY_PREFIX}${assetCode}`;
  return `${HISTORY_PREFIX}${assetCode}:${issuer}`;
}

async function detectAnomaly(currentPrice, assetCode, issuer) {
  const historyKey = buildHistoryKey(assetCode, issuer);

  let history = null;
  try {
    history = await cache.get(historyKey);
  } catch (err) {
    logger.warn('Cache read failed in anomaly detection, skipping', { error: err.message });
    return { anomalous: false, changePercent: 0 };
  }

  if (!history || !history.price || history.price <= 0) {
    try {
      await cache.set(historyKey, { price: currentPrice, timestamp: Date.now() }, 3600);
    } catch (err) {
      logger.warn('Cache write failed in anomaly detection', { error: err.message });
    }
    return { anomalous: false, changePercent: 0 };
  }

  const changePercent = Math.abs((currentPrice - history.price) / history.price) * 100;
  const anomalous = changePercent > config.price.anomalyThresholdPercent;

  if (anomalous) {
    logger.warn('Price anomaly detected', {
      assetCode,
      issuer,
      previousPrice: history.price,
      currentPrice,
      changePercent: changePercent.toFixed(2),
    });
  }

  try {
    await cache.set(historyKey, { price: currentPrice, timestamp: Date.now() }, 3600);
  } catch (err) {
    logger.warn('Cache write failed in anomaly detection', { error: err.message });
  }

  return { anomalous, changePercent };
}

async function fetchFromAllSources(assetCode, issuer) {
  const results = [];

  for (const source of SOURCES) {
    // A source that cannot serve this asset at all (e.g. CoinGecko has no
    // mapping for a non-XLM asset) is a permanent, per-asset condition, not
    // a source failure — skip the breaker-wrapped call entirely so it never
    // counts toward that source's failure threshold. Without this, a
    // source asked about even one asset it doesn't support would eventually
    // trip its circuit open for every asset it *does* support (#130).
    if (typeof source.isSupported === 'function' && !source.isSupported(assetCode, issuer)) {
      continue;
    }

    try {
      const price = await source.breaker.call(() => source.fetch(assetCode, issuer));
      if (price !== null && price > 0) {
        results.push({ source: source.name, price });
      }
    } catch (err) {
      logger.warn('Source fetch failed', { source: source.name, assetCode, error: err.message });
    }
  }

  return results;
}

function getCircuitStates() {
  return SOURCES.reduce((states, source) => {
    states[source.name] = source.breaker.getState();
    return states;
  }, {});
}

function resetCircuitBreakers() {
  for (const source of SOURCES) {
    source.breaker.reset();
  }
}

const QUERIED_ASSETS_KEY = 'queried_assets';

async function recordQueriedAsset(assetCode, issuer = null) {
  try {
    if (!cache.isConnected()) return;
    const redis = cache.getClient();
    const key = issuer ? `${assetCode}:${issuer}` : assetCode;
    await redis.sadd(QUERIED_ASSETS_KEY, key);
  } catch (err) {
    logger.warn('Failed to record queried asset', { assetCode, issuer, error: err.message });
  }
}

async function getQueriedAssets() {
  try {
    if (!cache.isConnected()) return [];
    const redis = cache.getClient();
    const members = await redis.smembers(QUERIED_ASSETS_KEY);
    return (members || []).map((entry) => {
      const [code, issuer] = entry.split(':');
      return { code, issuer: issuer || null };
    });
  } catch (err) {
    logger.warn('Failed to fetch queried assets', { error: err.message });
    return [];
  }
}

async function getPrice(assetCode, issuer = null) {
  recordQueriedAsset(assetCode, issuer);
  const cacheKey = buildCacheKey(assetCode, issuer);
  let redisUnavailable = false;

  try {
    const cached = await cache.get(cacheKey);
    if (cached) {
      const ageMs = Date.now() - cached.fetchedAt;
      const ageMinutes = ageMs / 60000;
      const isStale = ageMinutes > config.price.staleThresholdMinutes;

      return {
        asset_code: assetCode,
        issuer: issuer || null,
        price_usd: cached.price,
        source: cached.source,
        fetched_at: new Date(cached.fetchedAt).toISOString(),
        is_stale: isStale,
        stale_warning: isStale
          ? `Price is ${ageMinutes.toFixed(1)} minutes old (threshold: ${config.price.staleThresholdMinutes} min)`
          : null,
        sources_attempted: cached.sourcesAttempted || [],
        redis_unavailable: false,
      };
    }
  } catch (err) {
    logger.warn('Cache read failed, falling back to source fetch', { error: err.message });
    redisUnavailable = true;
  }

  return fetchFreshPrice(assetCode, issuer, redisUnavailable);
}

async function doFetchFreshPrice(assetCode, issuer = null, redisUnavailable = false) {
  const sourceResults = await fetchFromAllSources(assetCode, issuer);
  const sourcesAttempted = sourceResults.map((r) => r.source);
  const prices = sourceResults.map((r) => r.price);
  const quorumMet = sourcesAttempted.length >= config.price.minSources;

  const aggregatedPrice = median(prices);

  if (aggregatedPrice === null) {
    logger.warn('No price sources available', { assetCode, issuer });
    return {
      asset_code: assetCode,
      issuer: issuer || null,
      price_usd: null,
      source: 'unavailable',
      fetched_at: new Date().toISOString(),
      is_stale: true,
      stale_warning: 'No price data available from any source',
      sources_attempted: sourcesAttempted,
      redis_unavailable: redisUnavailable,
      quorum_met: false,
      anomalous: false,
    };
  }

  const primarySource = sourceResults.length > 0 ? sourceResults[0].source : 'aggregated';

  // Anomaly detection — quorum_met is computed from source count, independent of Redis
  let anomalous = false;
  if (!redisUnavailable) {
    const anomalyResult = await detectAnomaly(aggregatedPrice, assetCode, issuer);
    anomalous = anomalyResult.anomalous;
  }

  // In reject mode, fall back to last known good cached price for anomalous readings
  if (anomalous && config.price.anomalyAction === 'reject' && !redisUnavailable) {
    try {
      const cacheKey = buildCacheKey(assetCode, issuer);
      const cached = await cache.get(cacheKey);
      if (cached && cached.price) {
        logger.warn('Anomalous price rejected, returning cached price', {
          assetCode,
          issuer,
          rejectedPrice: aggregatedPrice,
          cachedPrice: cached.price,
        });
        return {
          asset_code: assetCode,
          issuer: issuer || null,
          price_usd: cached.price,
          source: cached.source || 'cached',
          fetched_at: new Date(cached.fetchedAt).toISOString(),
          is_stale: true,
          stale_warning: 'Anomalous price rejected — returning last known good price',
          sources_attempted: sourcesAttempted,
          redis_unavailable: redisUnavailable,
          quorum_met: quorumMet,
          anomalous: true,
        };
      }
    } catch (err) {
      logger.warn('Cache read failed during anomaly rejection, serving fetched price', { error: err.message });
    }
  }

  if (!redisUnavailable) {
    try {
      const cacheKey = buildCacheKey(assetCode, issuer);
      await cache.set(
        cacheKey,
        {
          price: aggregatedPrice,
          source: primarySource,
          fetchedAt: Date.now(),
          sourcesAttempted,
        },
        config.price.cacheTtl
      );
    } catch (err) {
      logger.warn('Cache write failed, continuing without caching', { error: err.message });
      redisUnavailable = true;
    }
  }

  return {
    asset_code: assetCode,
    issuer: issuer || null,
    price_usd: aggregatedPrice,
    source: primarySource,
    fetched_at: new Date().toISOString(),
    is_stale: false,
    stale_warning: null,
    sources_attempted: sourcesAttempted,
    redis_unavailable: redisUnavailable,
    quorum_met: quorumMet,
    anomalous,
  };
}

/**
 * Single-flight wrapper around doFetchFreshPrice. Concurrent calls for the
 * same assetCode:issuer pair while a fetch is already in-flight will await
 * the same promise instead of each independently hitting all upstream sources.
 */
async function fetchFreshPrice(assetCode, issuer = null, redisUnavailable = false) {
  const normalisedIssuer = issuer || null;
  const key = `${assetCode}:${normalisedIssuer}`;

  if (inFlight.has(key)) {
    const existing = inFlight.get(key);
    const coalescedCount = inFlight.size;
    logger.debug('Coalesced caller onto in-flight price fetch', {
      assetCode,
      issuer: normalisedIssuer,
      coalesced: coalescedCount,
    });
    return existing;
  }

  const promise = doFetchFreshPrice(assetCode, issuer, redisUnavailable)
    .finally(() => inFlight.delete(key));

  inFlight.set(key, promise);
  return promise;
}

async function refreshAllCachedPrices() {
  if (!cache.isConnected()) {
    logger.warn('Redis unavailable, skipping scheduled price refresh cycle');
    return;
  }

  const redis = cache.getClient();
  const keys = [];
  let cursor = '0';

  try {
    do {
      const result = await redis.scan(cursor, 'MATCH', `${CACHE_PREFIX}*`, 'COUNT', 100);
      cursor = result[0];
      keys.push(...result[1]);
    } while (cursor !== '0');
  } catch (err) {
    logger.warn('Redis scan failed during price refresh, aborting cycle', { error: err.message });
    return;
  }

  const freshPrices = {};

  const refreshPromises = keys
    .filter((key) => !key.includes(':history:'))
    .map(async (key) => {
      const suffix = key.replace(CACHE_PREFIX, '');
      const parts = suffix.split(':');
      const assetCode = parts[0];
      const issuer = parts.length > 1 ? parts[1] : null;
      const assetKey = issuer ? `${assetCode}:${issuer}` : assetCode;

      try {
        const result = await fetchFreshPrice(assetCode, issuer);
        if (result && result.price_usd !== null) {
          freshPrices[assetKey] = { price: result.price_usd, source: result.source };
        }
        logger.debug('Refreshed price', { assetCode, issuer });
      } catch (err) {
        logger.warn('Price refresh failed', { assetCode, issuer, error: err.message });
      }
    });

  await Promise.allSettled(refreshPromises);
  logger.info('Price refresh cycle completed', { keysRefreshed: keys.length });
  return freshPrices;
}

module.exports = {
  getPrice,
  fetchFreshPrice,
  getCircuitStates,
  resetCircuitBreakers,
  refreshAllCachedPrices,
  getQueriedAssets,
  recordQueriedAsset,
  // Internal helpers exported for unit testing.
  median,
  detectAnomaly,
  fetchFromAllSources,
  getSourceCircuitStates,
  inFlight,
};
