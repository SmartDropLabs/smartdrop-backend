'use strict';

// --- Mocks (must precede all imports) ---

jest.mock('../src/services/cache', () => ({
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  disconnect: jest.fn(),
  isConnected: jest.fn(() => false),
}));

process.env.ADMIN_API_KEY = 'b'.repeat(64);

const express = require('express');
const request = require('supertest');

const mockGetPrice = jest.fn();
const mockFetchFreshPrice = jest.fn();

jest.mock('../src/services/priceOracle', () => ({
  getPrice: mockGetPrice,
  fetchFreshPrice: mockFetchFreshPrice,
}));

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../src/services/apiKeys', () => ({
  validateApiKey: jest.fn(),
}));

// --- Imports ---

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

// Valid 56-char Stellar address (G + 55 uppercase alphanumeric chars)
const VALID_ISSUER = 'G' + 'A'.repeat(55);

const pricesRouter = require('../src/routes/prices');
const logger = require('../src/logger');
const { errorHandler } = require('../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', pricesRouter);
  app.use(errorHandler);
  return app;
}

function priceResponse(overrides = {}) {
  return {
    asset_code: 'USDC',
    issuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    price_usd: 1.01,
    source: 'coingecko',
    fetched_at: '2026-06-25T00:00:00.000Z',
    is_stale: false,
    stale_warning: null,
    sources_attempted: ['coingecko'],
    redis_unavailable: false,
    ...overrides,
  };
}

describe('price routes', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    mockGetPrice.mockReset();
    mockFetchFreshPrice.mockReset();
    logger.error.mockClear();
  });

  test('GET /prices/:asset_code returns the full price response shape', async () => {
    mockGetPrice.mockResolvedValueOnce(priceResponse());

    const res = await request(app)
      .get('/api/v1/prices/usdc')
      .query({ issuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });

    expect(res.status).toBe(200);
    expect(mockGetPrice).toHaveBeenCalledWith(
      'USDC',
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    );
    expect(res.body).toEqual({
      asset_code: 'USDC',
      issuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      price_usd: 1.01,
      source: 'coingecko',
      fetched_at: '2026-06-25T00:00:00.000Z',
      is_stale: false,
      stale_warning: null,
      sources_attempted: ['coingecko'],
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

  test('GET /prices/:asset_code preserves stale warnings from the oracle', async () => {
    mockGetPrice.mockResolvedValueOnce(
      priceResponse({
        is_stale: true,
        stale_warning: 'Price is 45.0 minutes old (threshold: 30 min)',
      })
    );

    const res = await request(app).get('/api/v1/prices/USDC');

    expect(res.status).toBe(200);
    expect(res.body.is_stale).toBe(true);
    expect(res.body.stale_warning).toBe('Price is 45.0 minutes old (threshold: 30 min)');
  });

  test('GET /prices/:asset_code handles native XLM without an issuer', async () => {
    mockGetPrice.mockResolvedValueOnce(
      priceResponse({
        asset_code: 'XLM',
        issuer: null,
        price_usd: 0.12,
        source: 'stellar_dex',
      })
    );

    const res = await request(app).get('/api/v1/prices/xlm');

    expect(res.status).toBe(200);
    expect(mockGetPrice).toHaveBeenCalledWith('XLM', null);
    expect(res.body.asset_code).toBe('XLM');
    expect(res.body.issuer).toBeNull();
  });

  test('GET /prices/:asset_code returns 404 with stale warning when no source has data', async () => {
    mockGetPrice.mockResolvedValueOnce(
      priceResponse({
        price_usd: null,
        source: 'unavailable',
        is_stale: true,
        stale_warning: 'No price data available from any source',
      })
    );

    const res = await request(app).get('/api/v1/prices/UNKNOWN');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({
      code: 'NOT_FOUND',
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
  let app;

  beforeEach(() => {
    app = buildApp();
    mockGetPrice.mockReset();
    mockFetchFreshPrice.mockReset();
    apiKeys.validateApiKey.mockReset();
    logger.error.mockClear();
  });

  test('no Authorization header — 401', async () => {
    const res = await request(app).get('/api/v1/prices/XLM/refresh');

    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'UNAUTHORIZED', message: 'Missing or invalid API key' });
  });

  test('invalid API key — 401', async () => {
    apiKeys.validateApiKey.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/v1/prices/XLM/refresh')
      .set('Authorization', 'Bearer bad-key');

    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'UNAUTHORIZED', message: 'Missing or invalid API key' });
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
    expect(res.body.error).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(res.body).not.toHaveProperty('stack');
    expect(JSON.stringify(res.body)).not.toContain('External source failed');
  });

  test('GET /prices/:asset_code rejects invalid asset codes before oracle lookup', async () => {
    const res = await request(app).get('/api/v1/prices/TOO-LONG-ASSET');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
    });
    expect(res.body.error.details.fields.asset_code).toEqual(
      expect.arrayContaining(['Asset code must be alphanumeric'])
    );
    expect(mockGetPrice).not.toHaveBeenCalled();
  });

  test('GET /prices/:asset_code rejects malformed issuers before oracle lookup', async () => {
    const res = await request(app)
      .get('/api/v1/prices/USDC')
      .query({ issuer: 'not-a-stellar-address' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
    });
    expect(res.body.error.details.fields.issuer).toEqual(
      expect.arrayContaining(['Must be a valid Stellar public key'])
    );
    expect(mockGetPrice).not.toHaveBeenCalled();
  });

  test('GET /prices/:asset_code hides stack traces on unhandled oracle errors', async () => {
    mockGetPrice.mockRejectedValueOnce(new Error('redis exploded with stack details'));

    const res = await request(app).get('/api/v1/prices/XLM');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(res.body)).not.toContain('redis exploded');
  });

  test('GET /prices/:asset_code/refresh validates params and calls fresh oracle lookup', async () => {
    apiKeys.validateApiKey.mockResolvedValue({ scopes: [] });
    mockFetchFreshPrice.mockResolvedValueOnce(
      priceResponse({
        asset_code: 'USDC',
        source: 'stellar_dex',
        sources_attempted: ['stellar_dex'],
      })
    );

    const res = await request(app)
      .get('/api/v1/prices/usdc/refresh')
      .set('Authorization', `Bearer ${process.env.ADMIN_API_KEY}`)
      .query({ issuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });

    expect(res.status).toBe(200);
    expect(mockFetchFreshPrice).toHaveBeenCalledWith(
      'USDC',
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    );
    expect(res.body.source).toBe('stellar_dex');
  });
});
