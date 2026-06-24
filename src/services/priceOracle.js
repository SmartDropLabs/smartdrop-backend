const cache = require('./cache');
const stellarDex = require('./sources/stellarDex');
const coingecko = require('./sources/coingecko');
const coinmarketcap = require('./sources/coinmarketcap');
const config = require('../config');
const logger = require('../logger');

const CACHE_PREFIX = 'price:';
const HISTORY_PREFIX = 'price:history:';
const SOURCES = [
  { name: 'stellar_dex', fetch: stellarDex.fetchPrice },
  { name: 'coingecko', fetch: coingecko.fetchPrice },
  { name: 'coinmarketcap', fetch: coinmarketcap.fetchPrice },
];

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
    return false;
  }

  if (!history || !history.price || history.price <= 0) {
    try {
      await cache.set(historyKey, { price: currentPrice, timestamp: Date.now() }, 3600);
    } catch (err) {
      logger.warn('Cache write failed in anomaly detection', { error: err.message });
    }
    return false;
  }

  const changePercent = Math.abs((currentPrice - history.price) / history.price) * 100;

  if (changePercent > config.price.anomalyThresholdPercent) {
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

  return changePercent > config.price.anomalyThresholdPercent;
}

async function fetchFromAllSources(assetCode, issuer) {
  const results = [];

  for (const source of SOURCES) {
    try {
      const price = await source.fetch(assetCode, issuer);
      if (price !== null && price > 0) {
        results.push({ source: source.name, price });
      }
    } catch (err) {
      logger.warn('Source fetch failed', { source: source.name, assetCode, error: err.message });
    }
  }

  return results;
}

async function getPrice(assetCode, issuer = null) {
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

async function fetchFreshPrice(assetCode, issuer = null, redisUnavailable = false) {
  const sourceResults = await fetchFromAllSources(assetCode, issuer);
  const sourcesAttempted = sourceResults.map((r) => r.name);
  const prices = sourceResults.map((r) => r.price);

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
    };
  }

  const primarySource = sourceResults.length > 0 ? sourceResults[0].source : 'aggregated';

  if (!redisUnavailable) {
    await detectAnomaly(aggregatedPrice, assetCode, issuer);
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
  };
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

  const refreshPromises = keys
    .filter((key) => !key.includes(':history:'))
    .map(async (key) => {
      const suffix = key.replace(CACHE_PREFIX, '');
      const parts = suffix.split(':');
      const assetCode = parts[0];
      const issuer = parts.length > 1 ? parts[1] : null;

      try {
        await fetchFreshPrice(assetCode, issuer);
        logger.debug('Refreshed price', { assetCode, issuer });
      } catch (err) {
        logger.warn('Price refresh failed', { assetCode, issuer, error: err.message });
      }
    });

  await Promise.allSettled(refreshPromises);
  logger.info('Price refresh cycle completed', { keysRefreshed: keys.length });
}

module.exports = {
  getPrice,
  fetchFreshPrice,
  refreshAllCachedPrices,
};
