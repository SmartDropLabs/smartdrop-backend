'use strict';

const request = require('supertest');
const express = require('express');
const runtimeConfig = require('../src/services/runtimeConfig');
const { buildRateLimit } = require('../src/middleware/rateLimit');
const baseConfig = require('../src/config');
const cache = require('../src/services/cache');

describe('Runtime Config Integration & Subscribers', () => {
  let app;
  let mockRedis;

  beforeEach(() => {
    runtimeConfig.reset();
    runtimeConfig.removeAllListeners();

    // mock redis store
    const store = new Map();
    mockRedis = {
      status: 'ready',
      incr: jest.fn(async (key) => {
        const current = store.get(key) || 0;
        const next = current + 1;
        store.set(key, next);
        return next;
      }),
      expire: jest.fn(async () => 1),
      get: jest.fn(async (key) => store.get(key) || null),
      set: jest.fn(async (key, val) => {
        store.set(key, val);
        return 'OK';
      }),
    };
    jest.spyOn(cache, 'getClient').mockReturnValue(mockRedis);
  });

  afterEach(() => {
    runtimeConfig.stopWatcher();
    runtimeConfig.reset();
    runtimeConfig.removeAllListeners();
    jest.restoreAllMocks();
  });

  test('rate limiter middleware updates limit dynamically when config changes', async () => {
    let currentLimit = runtimeConfig.get('rateLimitMax');
    let currentWindow = Math.floor(runtimeConfig.get('rateLimitWindowMs') / 1000);

    const limiter = (req, res, next) => {
      return buildRateLimit({
        windowSeconds: currentWindow,
        max: currentLimit,
        keyPrefix: 'test-dynamic',
      })(req, res, next);
    };

    runtimeConfig.on('change:rateLimitMax', (newMax) => {
      currentLimit = newMax;
    });

    app = express();
    app.use(limiter);
    app.get('/test', (req, res) => res.json({ ok: true }));

    // Request 1 with default limit
    const res1 = await request(app).get('/test');
    expect(res1.status).toBe(200);
    expect(res1.headers['x-ratelimit-limit']).toBe(String(baseConfig.rateLimit.max));

    // Hot-reload config change
    runtimeConfig.applyChanges({ rateLimitMax: 5 });

    // Next request should reflect new rate limit
    const res2 = await request(app).get('/test');
    expect(res2.status).toBe(200);
    expect(res2.headers['x-ratelimit-limit']).toBe('5');
  });

  test('syncs from redis when watcher checks config:runtime key', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({
      rateLimitMax: 42,
      priceAnomalyAction: 'reject',
    }));

    await runtimeConfig.syncFromRedis();

    expect(runtimeConfig.get('rateLimitMax')).toBe(42);
    expect(runtimeConfig.get('priceAnomalyAction')).toBe('reject');
  });
});
