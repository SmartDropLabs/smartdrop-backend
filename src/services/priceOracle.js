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
  const history = await cache.get(historyKey);

  if (!history || !history.price) {
    await cache.set(historyKey, { price: currentPrice, timestamp: Date.now() }, 3600);
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

  await cache.set(historyKey, { price: currentPrice, timestamp: Date.now() }, 3600);
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
    };
  }

  return fetchFreshPrice(assetCode, issuer);
}

async function fetchFreshPrice(assetCode, issuer = null) {
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
    };
  }

  const primarySource = sourceResults.length > 0 ? sourceResults[0].source : 'aggregated';

  await detectAnomaly(aggregatedPrice, assetCode, issuer);

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

  return {
    asset_code: assetCode,
    issuer: issuer || null,
    price_usd: aggregatedPrice,
    source: primarySource,
    fetched_at: new Date().toISOString(),
    is_stale: false,
    stale_warning: null,
    sources_attempted: sourcesAttempted,
  };
}

async function refreshAllCachedPrices() {
  const redis = cache.getClient();
  const keys = await redis.keys(`${CACHE_PREFIX}*`);

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
