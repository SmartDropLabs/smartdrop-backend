const axios = require('axios');
const config = require('../../config');
const logger = require('../../logger');

const STELLAR_COINGECKO_MAP = {
  XLM: 'stellar',
};

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

  try {
    const client = getClient();
    const response = await client.get('/simple/price', {
      params: {
        ids: coinId,
        vs_currencies: 'usd',
      },
    });

    const price = response.data[coinId]?.usd;
    if (price === undefined || price === null) {
      return null;
    }

    return price;
  } catch (err) {
    if (err.response?.status === 429) {
      logger.warn('CoinGecko rate limit hit', { assetCode });
    } else {
      logger.warn('CoinGecko price fetch failed', { assetCode, error: err.message });
    }
    return null;
  }
}

module.exports = { fetchPrice };
