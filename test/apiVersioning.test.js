'use strict';

const request = require('supertest');

jest.mock('../src/services/cache', () => ({
  isConnected: () => true,
  disconnect: jest.fn(),
  getConcurrencyStats: () => ({ active: 0, waiting: 0, available: 50, max: 50 }),
  getCommandQueueLength: () => 0,
  getClient: () => ({
    incr: async () => 1,
    expire: async () => 1,
  }),
  get: jest.fn(async (key) => {
    if (key === 'price:XLM') {
      return {
        asset_code: 'XLM',
        issuer: null,
        price_usd: 0.12,
        source: 'coingecko',
        timestamp: '2026-06-27T12:00:00.000Z',
      };
    }
    return null;
  }),
  set: jest.fn(),
  mget: jest.fn(async () => []),
}));

jest.mock('../src/services/priceOracle', () => ({
  getPrice: jest.fn(async (code) => {
    if (code === 'XLM') {
      return {
        asset_code: 'XLM',
        issuer: null,
        price_usd: 0.12,
        source: 'coingecko',
        timestamp: '2026-06-27T12:00:00.000Z',
      };
    }
    return { asset_code: code, issuer: null, price_usd: null, source: null, timestamp: null };
  }),
  getCircuitStates: jest.fn(() => ({})),
  getSourceCircuitStates: jest.fn(() => ({})),
}));

const { app } = require('../src/index');

describe('Issue #460: API URL-Path Versioning and Backward Compatibility', () => {
  describe('Path versioning and backward compatibility', () => {
    test('/v1/<route> and legacy paths return the same response data', async () => {
      const v1Res = await request(app).get('/v1/prices/XLM');
      const legacyApiRes = await request(app).get('/api/prices/XLM');
      const apiV1Res = await request(app).get('/api/v1/prices/XLM');

      expect(v1Res.status).toBe(200);
      expect(legacyApiRes.status).toBe(200);
      expect(apiV1Res.status).toBe(200);

      // Verify bodies match identically (ignoring unique correlation request_id)
      const { request_id: _v1Id, correlation_id: _v1Corr, ...v1Body } = v1Res.body;
      const { request_id: _legId, correlation_id: _legCorr, ...legacyBody } = legacyApiRes.body;
      const { request_id: _apiV1Id, correlation_id: _apiV1Corr, ...apiV1Body } = apiV1Res.body;

      expect(v1Body).toEqual(legacyBody);
      expect(v1Body).toEqual(apiV1Body);
      expect(v1Body.asset_code).toBe('XLM');
      expect(v1Body.price_usd).toBe(0.12);
    });

    test('versioned paths (/v1 and /api/v1) do not have deprecation headers', async () => {
      const v1Res = await request(app).get('/v1/prices/XLM');
      const apiV1Res = await request(app).get('/api/v1/prices/XLM');

      expect(v1Res.headers['deprecation']).toBeUndefined();
      expect(v1Res.headers['sunset']).toBeUndefined();

      expect(apiV1Res.headers['deprecation']).toBeUndefined();
      expect(apiV1Res.headers['sunset']).toBeUndefined();
    });

    test('legacy unversioned paths include Deprecation and Sunset response headers', async () => {
      const legacyApiRes = await request(app).get('/api/prices/XLM');
      expect(legacyApiRes.status).toBe(200);
      expect(legacyApiRes.headers['deprecation']).toBe('true');
      expect(legacyApiRes.headers['sunset']).toBeDefined();

      const legacyRootRes = await request(app).get('/prices/XLM');
      expect(legacyRootRes.status).toBe(200);
      expect(legacyRootRes.headers['deprecation']).toBe('true');
      expect(legacyRootRes.headers['sunset']).toBeDefined();
    });
  });

  describe('Unknown version rejection', () => {
    test('unknown version /v99/... returns a clear 404 error', async () => {
      const res = await request(app).get('/v99/prices/XLM');

      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.error.message).toContain("API version 'v99' is not supported");
      expect(res.body.error.details).toEqual({
        requested_version: 'v99',
        supported_versions: ['v1'],
      });
    });

    test('unknown version /api/v99/... returns a clear 404 error', async () => {
      const res = await request(app).get('/api/v99/prices/XLM');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.error.message).toContain("API version 'v99' is not supported");
    });

    test('unsupported version /v2/... returns 404 as v2 is not created yet', async () => {
      const res = await request(app).get('/v2/prices/XLM');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.error.message).toContain("API version 'v2' is not supported");
    });
  });

  describe('Infrastructure endpoints remain unversioned and reachable', () => {
    test('/health remains reachable without deprecation headers', async () => {
      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBeDefined();
      expect(res.headers['deprecation']).toBeUndefined();
    });

    test('/health/live remains reachable without deprecation headers', async () => {
      const res = await request(app).get('/health/live');

      expect(res.status).toBe(200);
      expect(res.headers['deprecation']).toBeUndefined();
    });

    test('/api-docs remains reachable without deprecation headers', async () => {
      const res = await request(app).get('/api-docs/openapi.yaml');

      expect(res.status).toBe(200);
      expect(res.headers['deprecation']).toBeUndefined();
    });
  });
});
