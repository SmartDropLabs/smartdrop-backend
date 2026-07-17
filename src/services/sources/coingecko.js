const axios = require('axios');
const config = require('../../config');
const logger = require('../../logger');
const { createCircuitBreaker } = require('./circuitBreaker');

const STELLAR_COINGECKO_MAP = {
  XLM: 'stellar',
};

const circuit = createCircuitBreaker({
  sourceName: 'coingecko',
  cooldownMs: config.priceSources.circuitCooldownMs,
  reminderIntervalMs: config.priceSources.circuitReminderIntervalMs,
});

let apiClient = null;

function getClient() {
  if (!apiClient) {
    const headers = { Accept: 'application/json' };
    if (config.coingecko.apiKey) {
      headers['x-cg-demo-api-key'] = config.coingecko.apiKey;
    }
    apiClient = axios.create({
      baseURL: config.coingecko.baseUrl,
      headers,
      timeout: 10000,
    });
  }
  return apiClient;
}

async function fetchPrice(assetCode) {
  const coinId = STELLAR_COINGECKO_MAP[assetCode];
  if (!coinId) {
    logger.debug('Asset not supported by CoinGecko', { assetCode });
    return null;
  }

  if (circuit.isOpen()) {
    circuit.noteSkipped({ assetCode });
    return null;
  }

  try {
    const client = getClient();
    const response = await client.get('/simple/price', {
      params: {
        ids: coinId,
        vs_currencies: 'usd',
      },
    });

    // A successful HTTP round-trip means any configured API key is valid,
    // regardless of whether this particular coin had usable price data.
    circuit.close();

    const price = response.data[coinId]?.usd;
    if (price === undefined || price === null) {
      return null;
    }

    return price;
  } catch (err) {
    if (err.response?.status === 401) {
      // Per CoinGecko's docs, 401 means a missing/invalid API key — a
      // permanent misconfiguration, not something that self-heals on
      // retry. Distinct from 403 (CDN/firewall block) and 429 (rate
      // limit), neither of which indicate a bad key.
      err.nonRetryable = true;
      circuit.open({ assetCode });
      logger.warn('CoinGecko authentication failed', { assetCode });
      throw err;
    }
    if (err.response?.status === 429) {
      logger.warn('CoinGecko rate limit hit', { assetCode });
    } else {
      logger.warn('CoinGecko price fetch failed', { assetCode, error: err.message });
    }
    return null;
  }
}

module.exports = { fetchPrice, getCircuitState: circuit.getState };
