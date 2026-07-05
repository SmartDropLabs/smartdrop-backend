'use strict';

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
      message: 'No price data found for UNKNOWN',
    });
  });

  test('GET /prices/:asset_code rejects invalid asset codes before oracle lookup', async () => {
    const res = await request(app).get('/api/v1/prices/TOO-LONG-ASSET');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Asset code must be 1-12 uppercase alphanumeric characters',
    });
    expect(mockGetPrice).not.toHaveBeenCalled();
  });

  test('GET /prices/:asset_code rejects malformed issuers before oracle lookup', async () => {
    const res = await request(app)
      .get('/api/v1/prices/USDC')
      .query({ issuer: 'not-a-stellar-address' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Issuer must be a valid Stellar address (G...)',
    });
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
