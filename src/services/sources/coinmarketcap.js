const axios = require('axios');
const config = require('../../config');
const logger = require('../../logger');
const { createCircuitBreaker } = require('./circuitBreaker');

const circuit = createCircuitBreaker({
  sourceName: 'coinmarketcap',
  cooldownMs: config.priceSources.circuitCooldownMs,
  reminderIntervalMs: config.priceSources.circuitReminderIntervalMs,
});

let apiClient = null;

function getClient() {
  if (!apiClient) {
    apiClient = axios.create({
      baseURL: config.coinmarketcap.baseUrl,
      headers: {
        'Accept': 'application/json',
        'X-CMC_PRO_API_KEY': config.coinmarketcap.apiKey,
      },
      timeout: 10000,
    });
  }
  return apiClient;
}

function resolveMarket(assetCode, issuer) {
  const normalizedIssuer = issuer || null;

  if (normalizedIssuer) {
    const market = config.coinmarketcap.assetIssuerMap?.[`${assetCode}:${normalizedIssuer}`];
    if (!market) {
      logger.debug('Issuer not supported by CoinMarketCap', { assetCode, issuer: normalizedIssuer });
      return null;
    }
    return market;
  }

  const market = config.coinmarketcap.assetIssuerMap?.[assetCode];
  if (!market) {
    logger.debug('Asset not supported by CoinMarketCap', { assetCode, issuer: normalizedIssuer });
    return null;
  }

  if (market === null) {
    logger.debug('Issuer not supported by CoinMarketCap', { assetCode, issuer: normalizedIssuer });
    return null;
  }

  return market;
}

/**
 * Whether this source can serve the given asset/issuer at all — distinct
 * from a transient fetch failure. Callers (priceOracle's fetchFromAllSources)
 * check this before ever invoking the circuit-breaker-wrapped fetchPrice, so
 * an asset/issuer combination missing from assetIssuerMap never counts
 * toward this source's failure threshold (#130). Reuses resolveMarket so
 * this can never drift from fetchPrice's own notion of "supported".
 */
function isSupported(assetCode, issuer = null) {
  return Boolean(resolveMarket(assetCode, issuer));
}

async function fetchPrice(assetCode, issuer = null) {
  if (!config.coinmarketcap.apiKey) {
    logger.debug('CoinMarketCap API key not configured');
    return null;
  }

  const market = resolveMarket(assetCode, issuer);
  if (!market) {
    return null;
  }

  if (circuit.isOpen()) {
    circuit.noteSkipped({ assetCode });
    return null;
  }

  try {
    const client = getClient();
    const lookupKey = market.id ? String(market.id) : market.symbol;
    const response = await client.get('/cryptocurrency/quotes/latest', {
      params: {
        ...(market.id ? { id: market.id } : { symbol: market.symbol }),
        convert: 'USD',
      },
    });

    // A successful HTTP round-trip means the API key is valid, regardless
    // of whether this particular asset had usable quote data — close the
    // circuit before evaluating the response shape.
    circuit.close();

    const data = response.data?.data?.[lookupKey];
    if (!data || !data.quote?.USD?.price) {
      return null;
    }

    return data.quote.USD.price;
  } catch (err) {
    if (err.response?.status === 401) {
      err.nonRetryable = true;
      circuit.open({ assetCode });
      logger.warn('CoinMarketCap authentication failed', { assetCode });
      throw err;
    }
    if (err.response?.status === 429) {
      logger.warn('CoinMarketCap rate limit hit', {
        assetCode,
        retry_after: err.response.headers?.['retry-after'] || null,
      });
    } else {
      logger.warn('CoinMarketCap price fetch failed', { assetCode, error: err.message });
    }
    return null;
  }
}

module.exports = { fetchPrice, isSupported, getCircuitState: circuit.getState };
