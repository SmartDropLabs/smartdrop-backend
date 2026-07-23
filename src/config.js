require('dotenv').config();

const { cleanEnv, makeValidator, num, port, str, url } = require('envalid');

const stellarAddress = makeValidator((input) => {
  if (!/^G[A-Z0-9]{55}$/.test(input)) {
    throw new Error('must be a valid Stellar public key');
  }
  return input;
});

function parseWatchedAssets(input) {
  if (!input || !input.trim()) return [];

  const seen = new Set();
  return input
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [code, issuer, extra] = entry.split(':');

      if (extra !== undefined) {
        throw new Error(`invalid asset "${entry}"; expected CODE or CODE:ISSUER`);
      }

      if (!/^[A-Z0-9]{1,12}$/.test(code)) {
        throw new Error(`invalid asset code "${code}"; expected 1-12 uppercase alphanumeric characters`);
      }

      if (issuer !== undefined && !/^G[A-Z0-9]{55}$/.test(issuer)) {
        throw new Error(`invalid issuer for "${code}"; expected a Stellar public key`);
      }

      const asset = { code, issuer: issuer || null };
      const key = asset.issuer ? `${asset.code}:${asset.issuer}` : asset.code;
      if (seen.has(key)) return null;
      seen.add(key);
      return asset;
    })
    .filter(Boolean);
}

const watchedAssets = makeValidator(parseWatchedAssets);

const positiveInteger = makeValidator((input) => {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('must be a positive integer');
  }
  return value;
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
  AIRDROP_CSV_MAX_BYTES: positiveInteger({ default: 5 * 1024 * 1024 }),
  AIRDROP_JSON_MAX_BYTES: positiveInteger({ default: 2 * 1024 * 1024 }),
  AIRDROP_RATELIMIT_WINDOW: positiveInteger({ default: 60 }),
  AIRDROP_RATELIMIT_MAX: positiveInteger({ default: 10 }),
  PRICE_CACHE_TTL_SECONDS: num({ default: 60 }),
  PRICE_REFRESH_INTERVAL_SECONDS: num({ default: 30 }),
  PRICE_STALE_THRESHOLD_MINUTES: num({ default: 5 }),
  PRICE_ANOMALY_THRESHOLD_PCT: num({ default: 20 }),
  PRICE_SOURCE_CIRCUIT_COOLDOWN_MS: num({ default: 15 * 60 * 1000 }),
  PRICE_SOURCE_CIRCUIT_REMINDER_MS: num({ default: 5 * 60 * 1000 }),
  AIRDROP_EXPIRY_CHECK_INTERVAL_SECONDS: num({ default: 60 }),
  AIRDROP_LEDGER_CACHE_TTL_MS: num({ default: 5000 }),
  AIRDROP_EXPIRY_SCAN_BATCH_SIZE: num({ default: 100 }),
  WATCHED_ASSETS: watchedAssets({ default: '' }),
  LOG_LEVEL: str({
    default: 'info',
    choices: ['debug', 'info', 'warn', 'error'],
  }),
});

const usdcIssuer = env.USDC_ISSUER;
const parsedWatchedAssets = Array.isArray(env.WATCHED_ASSETS)
  ? env.WATCHED_ASSETS
  : parseWatchedAssets(env.WATCHED_ASSETS);

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
  },
  priceSources: {
    // How long a source's circuit stays open after a nonRetryable (e.g. 401)
    // failure before it's attempted again.
    circuitCooldownMs: env.PRICE_SOURCE_CIRCUIT_COOLDOWN_MS,
    // Minimum gap between repeated "circuit open, skipping" log lines while
    // the circuit stays open, so a misconfigured key doesn't spam one log
    // line per fetch cycle for the entire cooldown window.
    circuitReminderIntervalMs: env.PRICE_SOURCE_CIRCUIT_REMINDER_MS,
  },
  airdrops: {
    // How often the expiry reconciliation job scans non-terminal airdrops
    // against the live Horizon ledger sequence.
    expiryCheckIntervalSeconds: env.AIRDROP_EXPIRY_CHECK_INTERVAL_SECONDS,
    // getCurrentLedger() is a live Horizon call with no caching; a job that
    // polls frequently should reuse the same ledger sequence for this long
    // rather than hitting Horizon once per airdrop per cycle.
    ledgerCacheTtlMs: env.AIRDROP_LEDGER_CACHE_TTL_MS,
    // SSCAN batch size used when scanning the full airdrop ID set — keeps
    // each Redis round-trip small instead of loading the whole set (SMEMBERS)
    // into memory at once.
    expiryScanBatchSize: env.AIRDROP_EXPIRY_SCAN_BATCH_SIZE,
    csvMaxBytes: env.AIRDROP_CSV_MAX_BYTES,
    jsonMaxBytes: env.AIRDROP_JSON_MAX_BYTES,
    maxRecipients: 10000,
    rateLimit: {
      windowSeconds: env.AIRDROP_RATELIMIT_WINDOW,
      max: env.AIRDROP_RATELIMIT_MAX,
    },
  },
  watchedAssets: parsedWatchedAssets,
  auth: {
    adminApiKey: env.ADMIN_API_KEY,
  },
  corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:3001')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000,
    max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 100,
  },
  priceRateLimit: {
    windowSeconds: parseInt(process.env.PRICE_RATELIMIT_WINDOW, 10) || 60,
    max: parseInt(process.env.PRICE_RATELIMIT_MAX, 10) || 30,
  },
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
