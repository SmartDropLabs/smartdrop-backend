const axios = require('axios');
const config = require('../../config');
const logger = require('../../logger');

const STELLAR_CMC_MAP = {
  XLM: 'XLM',
};

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

async function fetchPrice(assetCode) {
  if (!config.coinmarketcap.apiKey) {
    logger.debug('CoinMarketCap API key not configured');
    return null;
  }

  const symbol = STELLAR_CMC_MAP[assetCode];
  if (!symbol) {
    logger.debug('Asset not supported by CoinMarketCap', { assetCode });
    return null;
  }

  try {
    const client = getClient();
    const response = await client.get('/cryptocurrency/quotes/latest', {
      params: {
        symbol,
        convert: 'USD',
      },
    });

    const data = response.data?.data?.[symbol];
    if (!data || !data.quote?.USD?.price) {
      return null;
    }

    return data.quote.USD.price;
  } catch (err) {
    if (err.response?.status === 429) {
      logger.warn('CoinMarketCap rate limit hit', { assetCode });
    } else {
      logger.warn('CoinMarketCap price fetch failed', { assetCode, error: err.message });
    }
    return null;
  }
}

module.exports = { fetchPrice };
