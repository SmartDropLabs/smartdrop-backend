'use strict';

const express = require('express');
const request = require('supertest');
const { createCacheMock } = require('./helpers/cacheMock');

const mockHelper = createCacheMock();
const { reset } = mockHelper;

jest.mock('../src/services/cache', () => mockHelper.cacheMock);
jest.mock('../src/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const mockGetPrice = jest.fn();
jest.mock('../src/services/priceOracle', () => ({
  getPrice: mockGetPrice,
  fetchFreshPrice: jest.fn(),
}));

const buildRateLimit = require('../src/middleware/rateLimit');
const pricesRouter = require('../src/routes/prices');
const { errorHandler } = require('../src/middleware/errorHandler');

function priceResponse() {
  return {
    asset_code: 'XLM',
    issuer: null,
    price_usd: 0.12,
    source: 'coingecko',
    fetched_at: '2026-06-25T00:00:00.000Z',
    is_stale: false,
    stale_warning: null,
    sources_attempted: ['coingecko'],
    redis_unavailable: false,
  };
}

function buildApiApp({ globalMax = 100, globalWindowSeconds = 60 } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', buildRateLimit({
    windowSeconds: globalWindowSeconds,
    max: globalMax,
    keyPrefix: 'api',
  }));
  app.use('/api/v1', pricesRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  reset();
  mockGetPrice.mockReset();
  mockGetPrice.mockResolvedValue(priceResponse());
});

describe('API rate limiting integration', () => {
  test('global limit returns 429 after max requests per IP', async () => {
    const app = buildApiApp({ globalMax: 2, globalWindowSeconds: 60 });

    await request(app).get('/api/v1/prices/XLM');
    await request(app).get('/api/v1/prices/XLM');
    const blocked = await request(app).get('/api/v1/prices/XLM');

    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.body.error.details.retry_after_seconds).toBeGreaterThan(0);
    expect(blocked.headers['x-ratelimit-limit']).toBe('2');
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  test('prices routes enforce stricter 30 req/min limit', async () => {
    const app = buildApiApp({ globalMax: 100, globalWindowSeconds: 60 });

    for (let i = 0; i < 30; i += 1) {
      const res = await request(app).get('/api/v1/prices/XLM');
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBe('30');
    }

    const blocked = await request(app).get('/api/v1/prices/XLM');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers['x-ratelimit-limit']).toBe('30');
  });

  test('successful responses include rate-limit headers', async () => {
    const app = buildApiApp({ globalMax: 100, globalWindowSeconds: 60 });
    const res = await request(app).get('/api/v1/prices/XLM');

    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('30');
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });
});
