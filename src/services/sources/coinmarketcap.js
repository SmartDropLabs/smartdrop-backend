const axios = require('axios');
const config = require('../../config');
const logger = require('../../logger');

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

async function fetchPrice(assetCode, issuer = null) {
  if (!config.coinmarketcap.apiKey) {
    logger.debug('CoinMarketCap API key not configured');
    return null;
  }

  const market = resolveMarket(assetCode, issuer);
  if (!market) {
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

    const data = response.data?.data?.[lookupKey];
    if (!data || !data.quote?.USD?.price) {
      return null;
    }

    return data.quote.USD.price;
  } catch (err) {
    if (err.response?.status === 401) {
      err.nonRetryable = true;
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

module.exports = { fetchPrice };
