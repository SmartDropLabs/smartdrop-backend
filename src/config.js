require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
  },
  stellar: {
    horizonUrl: process.env.STELLAR_HORIZON_URL || 'https://horizon.stellar.org',
  },
  coingecko: {
    apiKey: process.env.COINGECKO_API_KEY || '',
    baseUrl: 'https://api.coingecko.com/api/v3',
  },
  coinmarketcap: {
    apiKey: process.env.COINMARKETCAP_API_KEY || '',
    baseUrl: 'https://pro-api.coinmarketcap.com/v1',
  },
  price: {
    cacheTtl: parseInt(process.env.PRICE_CACHE_TTL, 10) || 60,
    refreshInterval: parseInt(process.env.PRICE_REFRESH_INTERVAL, 10) || 30,
    staleThresholdMinutes: parseInt(process.env.PRICE_STALE_THRESHOLD, 10) || 5,
    anomalyThresholdPercent: parseFloat(process.env.PRICE_ANOMALY_THRESHOLD, 10) || 10,
  },
};
