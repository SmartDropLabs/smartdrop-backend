require('dotenv').config();

const { cleanEnv, makeValidator, num, port, str, url } = require('envalid');

const stellarAddress = makeValidator((input) => {
  if (!/^G[A-Z0-9]{55}$/.test(input)) {
    throw new Error('must be a valid Stellar public key');
  }
  return input;
});

const databaseDevDefault =
  process.env.NODE_ENV === 'test'
    ? 'postgres://localhost/smartdrop_test'
    : 'postgres://localhost/smartdrop';

const rawEnv = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV || 'development',
};

const env = cleanEnv(rawEnv, {
  NODE_ENV: str({
    default: 'development',
    choices: ['development', 'test', 'production'],
  }),
  PORT: port({ default: 3000 }),
  REDIS_URL: url({ devDefault: 'redis://localhost:6379' }),
  DATABASE_URL: url({ devDefault: databaseDevDefault }),
  STELLAR_HORIZON_URL: url({ default: 'https://horizon.stellar.org' }),
  USDC_ISSUER: stellarAddress({
    default: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA',
  }),
  COINGECKO_API_KEY: str({ default: '' }),
  COINMARKETCAP_API_KEY: str({ default: '' }),
  ADMIN_API_KEY: str({ default: '' }),
  PRICE_CACHE_TTL_SECONDS: num({ default: 60 }),
  PRICE_REFRESH_INTERVAL_SECONDS: num({ default: 30 }),
  PRICE_STALE_THRESHOLD_MINUTES: num({ default: 5 }),
  PRICE_ANOMALY_THRESHOLD_PCT: num({ default: 20 }),
  PRICE_SOURCE_CIRCUIT_COOLDOWN_MS: num({ default: 15 * 60 * 1000 }),
  PRICE_SOURCE_CIRCUIT_REMINDER_MS: num({ default: 5 * 60 * 1000 }),
  LOG_LEVEL: str({
    default: 'info',
    choices: ['debug', 'info', 'warn', 'error'],
  }),
});

const usdcIssuer = env.USDC_ISSUER;

module.exports = {
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  databaseUrl: env.DATABASE_URL,
  redis: {
    url: env.REDIS_URL,
  },
  stellar: {
    horizonUrl: env.STELLAR_HORIZON_URL,
    usdcIssuer,
  },
  coingecko: {
    apiKey: env.COINGECKO_API_KEY,
    baseUrl: 'https://api.coingecko.com/api/v3',
  },
  coinmarketcap: {
    apiKey: env.COINMARKETCAP_API_KEY,
    baseUrl: 'https://pro-api.coinmarketcap.com/v1',
    assetIssuerMap: {
      XLM: { symbol: 'XLM' },
      [`USDC:${usdcIssuer}`]: { id: 3408 },
    },
  },
  price: {
    cacheTtl: env.PRICE_CACHE_TTL_SECONDS,
    refreshInterval: env.PRICE_REFRESH_INTERVAL_SECONDS,
    staleThresholdMinutes: env.PRICE_STALE_THRESHOLD_MINUTES,
    anomalyThresholdPercent: env.PRICE_ANOMALY_THRESHOLD_PCT,
    sourceCircuitCooldownMs: env.PRICE_SOURCE_CIRCUIT_COOLDOWN_MS,
    sourceCircuitReminderMs: env.PRICE_SOURCE_CIRCUIT_REMINDER_MS,
  },
  auth: {
    adminApiKey: env.ADMIN_API_KEY,
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
