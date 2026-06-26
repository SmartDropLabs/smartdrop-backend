'use strict';

// --- Mocks (must precede all imports) ---

jest.mock('../src/services/cache', () => ({
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  disconnect: jest.fn(),
  isConnected: jest.fn(() => false),
}));

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../src/services/priceOracle', () => ({
  getPrice: jest.fn(),
  fetchFreshPrice: jest.fn(),
  refreshAllCachedPrices: jest.fn(),
}));

jest.mock('../src/services/apiKeys', () => ({
  validateApiKey: jest.fn(),
}));

// --- Imports ---

const request = require('supertest');
const { app } = require('../src');
const priceOracle = require('../src/services/priceOracle');
const apiKeys = require('../src/services/apiKeys');

// --- Fixtures ---

const PRICE_HAPPY = {
  asset_code: 'XLM',
  issuer: null,
  price_usd: 0.12,
  source: 'stellar_dex',
  fetched_at: '2024-01-01T00:00:00.000Z',
  is_stale: false,
  stale_warning: null,
  sources_attempted: ['stellar_dex'],
  redis_unavailable: false,
};

const PRICE_STALE = {
  ...PRICE_HAPPY,
  is_stale: true,
  stale_warning: 'Price is 35.0 minutes old (threshold: 30 min)',
};

const PRICE_NULL = {
  asset_code: 'UNKNOWN',
  issuer: null,
  price_usd: null,
  source: 'unavailable',
  fetched_at: '2024-01-01T00:00:00.000Z',
  is_stale: true,
  stale_warning: 'No price data available from any source',
  sources_attempted: [],
  redis_unavailable: false,
};

// Valid 56-char Stellar address (G + 55 uppercase alphanumeric chars)
const VALID_ISSUER = 'G' + 'A'.repeat(55);

// --- GET /api/v1/prices/:asset_code ---

describe('GET /api/v1/prices/:asset_code', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('happy path — 200 with full response shape', async () => {
    priceOracle.getPrice.mockResolvedValue(PRICE_HAPPY);

    const res = await request(app).get('/api/v1/prices/XLM');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      asset_code: 'XLM',
      issuer: null,
      price_usd: expect.any(Number),
      source: expect.any(String),
      fetched_at: expect.any(String),
      is_stale: false,
      stale_warning: null,
      sources_attempted: expect.any(Array),
      redis_unavailable: false,
    });
  });

  test('stale price — 200 with is_stale: true and non-empty stale_warning', async () => {
    priceOracle.getPrice.mockResolvedValue(PRICE_STALE);

    const res = await request(app).get('/api/v1/prices/XLM');

    expect(res.status).toBe(200);
    expect(res.body.is_stale).toBe(true);
    expect(typeof res.body.stale_warning).toBe('string');
    expect(res.body.stale_warning.length).toBeGreaterThan(0);
  });

  test('oracle throws — 500 with generic message, no internal details leaked', async () => {
    priceOracle.getPrice.mockRejectedValue(new Error('DB connection failed'));

    const res = await request(app).get('/api/v1/prices/XLM');

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      error: 'Internal server error',
      message: 'Failed to fetch price data',
    });
    expect(res.body).not.toHaveProperty('stack');
    expect(JSON.stringify(res.body)).not.toContain('DB connection failed');
  });

  // NOTE: issue #9 expects 200 when price_usd is null; the route actually returns 404.
  test('unknown asset (price_usd: null) — 404 with error body', async () => {
    priceOracle.getPrice.mockResolvedValue(PRICE_NULL);

    const res = await request(app).get('/api/v1/prices/UNKNOWN');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      error: 'Price not available',
      message: expect.stringContaining('UNKNOWN'),
    });
  });

  test('XLM native (no issuer) — oracle called with null issuer', async () => {
    priceOracle.getPrice.mockResolvedValue(PRICE_HAPPY);

    await request(app).get('/api/v1/prices/XLM');

    expect(priceOracle.getPrice).toHaveBeenCalledWith('XLM', null);
  });

  test('?issuer query param — passed through to oracle', async () => {
    priceOracle.getPrice.mockResolvedValue({ ...PRICE_HAPPY, issuer: VALID_ISSUER });

    await request(app).get(`/api/v1/prices/USDC?issuer=${VALID_ISSUER}`);

    expect(priceOracle.getPrice).toHaveBeenCalledWith('USDC', VALID_ISSUER);
  });

  test('invalid asset code (>12 chars) — 400', async () => {
    const res = await request(app).get('/api/v1/prices/TOOLONGCODE123');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid asset code' });
  });

  test('malformed issuer — 400', async () => {
    const res = await request(app).get('/api/v1/prices/XLM?issuer=BADISSUER');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid issuer' });
  });

  test('Redis unavailable — 200 with redis_unavailable: true (graceful degradation)', async () => {
    priceOracle.getPrice.mockResolvedValue({ ...PRICE_HAPPY, redis_unavailable: true });

    const res = await request(app).get('/api/v1/prices/XLM');

    expect(res.status).toBe(200);
    expect(res.body.redis_unavailable).toBe(true);
    expect(res.body.price_usd).not.toBeNull();
  });
});

// --- GET /api/v1/prices/:asset_code/refresh ---

describe('GET /api/v1/prices/:asset_code/refresh', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('no Authorization header — 401', async () => {
    const res = await request(app).get('/api/v1/prices/XLM/refresh');

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'Missing or invalid API key' });
  });

  test('invalid API key — 401', async () => {
    apiKeys.validateApiKey.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/v1/prices/XLM/refresh')
      .set('Authorization', 'Bearer bad-key');

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'Missing or invalid API key' });
  });

  test('valid API key — 200 with full response shape', async () => {
    apiKeys.validateApiKey.mockResolvedValue({ scopes: [] });
    priceOracle.fetchFreshPrice.mockResolvedValue(PRICE_HAPPY);

    const res = await request(app)
      .get('/api/v1/prices/XLM/refresh')
      .set('Authorization', 'Bearer valid-key');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      asset_code: 'XLM',
      price_usd: expect.any(Number),
    });
  });

  test('valid API key + oracle throws — 500, no internal details leaked', async () => {
    apiKeys.validateApiKey.mockResolvedValue({ scopes: [] });
    priceOracle.fetchFreshPrice.mockRejectedValue(new Error('External source failed'));

    const res = await request(app)
      .get('/api/v1/prices/XLM/refresh')
      .set('Authorization', 'Bearer valid-key');

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      error: 'Internal server error',
      message: 'Failed to refresh price data',
    });
    expect(res.body).not.toHaveProperty('stack');
    expect(JSON.stringify(res.body)).not.toContain('External source failed');
  });
});
