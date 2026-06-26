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
    usdcIssuer: process.env.USDC_ISSUER || 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA',
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
  corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:3001')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  webhooks: {
    maxAttempts: parseInt(process.env.WEBHOOK_MAX_ATTEMPTS, 10) || 3,
    retryBaseMs: parseInt(process.env.WEBHOOK_RETRY_BASE_MS, 10) || 30000,
    retryFactor: parseFloat(process.env.WEBHOOK_RETRY_FACTOR) || 2,
    timeoutMs: parseInt(process.env.WEBHOOK_TIMEOUT_MS, 10) || 5000,
    retryPollMs: parseInt(process.env.WEBHOOK_RETRY_POLL_MS, 10) || 5000,
    retryBatchSize: parseInt(process.env.WEBHOOK_RETRY_BATCH, 10) || 25,
    rateLimit: {
      windowSeconds: parseInt(process.env.WEBHOOK_RATELIMIT_WINDOW, 10) || 60,
      max: parseInt(process.env.WEBHOOK_RATELIMIT_MAX, 10) || 60,
    },
    testRateLimit: {
      windowSeconds: parseInt(process.env.WEBHOOK_TEST_RATELIMIT_WINDOW, 10) || 60,
      max: parseInt(process.env.WEBHOOK_TEST_RATELIMIT_MAX, 10) || 5,
    },
  },
};
