'use strict';

/**
 * Per-API-key tiered rate limiting (issue #251).
 */

// Small limits keep the "exhaust the bucket" cases to a handful of
// requests rather than the production default of 100/min.
process.env.API_KEY_RATELIMIT_FREE_MAX = '3';
process.env.API_KEY_RATELIMIT_PRO_MAX = '30';
process.env.API_KEY_RATELIMIT_WINDOW_SECONDS = '60';

const express = require('express');
const request = require('supertest');
const { createCacheMock } = require('./helpers/cacheMock');

const mockHelper = createCacheMock();
const { reset, redis } = mockHelper;
// Captured before any test replaces it, so a test that stubs incr with a
// rejection can hand the real in-memory implementation back afterwards.
const realIncr = redis.incr.getMockImplementation();

jest.mock('../src/services/cache', () => mockHelper.cacheMock);
const mockLogger = {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
};
jest.mock('../src/logger', () => mockLogger);

const { buildApiKeyRateLimit, resolveTier } = require('../src/middleware/rateLimit');
const { errorHandler } = require('../src/middleware/errorHandler');
const config = require('../src/config');

function buildApp(apiKey, limiter = buildApiKeyRateLimit({ keyPrefix: 'apikey' })) {
  const app = express();
  app.use((req, _res, next) => {
    if (apiKey) req.apiKey = apiKey;
    next();
  });
  app.use(limiter);
  app.get('/test', (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  reset();
  redis.incr.mockReset();
  redis.incr.mockImplementation(realIncr);
  Object.values(mockLogger).forEach((fn) => fn.mockClear());
});

describe('resolveTier', () => {
  test('uses the key\'s configured tier when it is a known tier', () => {
    expect(resolveTier({ id: 'key_1', tier: 'pro' })).toEqual({
      tier: 'pro',
      max: config.apiKeyRateLimit.tiers.pro,
    });
  });

  test('falls back to the default tier for keys created before tiers existed', () => {
    expect(resolveTier({ id: 'key_1' })).toEqual({
      tier: config.apiKeyRateLimit.defaultTier,
      max: config.apiKeyRateLimit.tiers[config.apiKeyRateLimit.defaultTier],
    });
  });

  test('falls back to the default tier for an unknown tier name', () => {
    expect(resolveTier({ id: 'key_1', tier: 'enterprise' }).tier)
      .toBe(config.apiKeyRateLimit.defaultTier);
  });
});

describe('per-API-key rate limiting', () => {
  test('sets rate limit headers reflecting the key\'s tier', async () => {
    const app = buildApp({ id: 'key_free', tier: 'free' });

    const res = await request(app).get('/test');

    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe(String(config.apiKeyRateLimit.tiers.free));
    expect(res.headers['x-ratelimit-remaining'])
      .toBe(String(config.apiKeyRateLimit.tiers.free - 1));
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
    expect(res.headers['x-ratelimit-tier']).toBe('free');
  });

  test('a paid tier gets a higher limit than the free tier', async () => {
    const free = await request(buildApp({ id: 'key_a', tier: 'free' })).get('/test');
    const pro = await request(buildApp({ id: 'key_b', tier: 'pro' })).get('/test');

    expect(Number(pro.headers['x-ratelimit-limit']))
      .toBeGreaterThan(Number(free.headers['x-ratelimit-limit']));
  });

  test('returns 429 with Retry-After once the key exhausts its tier', async () => {
    const app = buildApp({ id: 'key_small', tier: 'free' });
    const max = config.apiKeyRateLimit.tiers.free;

    for (let i = 0; i < max; i += 1) {
      const ok = await request(app).get('/test');
      expect(ok.status).toBe(200);
    }

    const blocked = await request(app).get('/test');

    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatchObject({ code: 'RATE_LIMITED' });
    expect(blocked.body.error.details).toMatchObject({ tier: 'free', limit: max });
    expect(blocked.body.error.details.retry_after_seconds).toBeGreaterThan(0);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
  });

  test('one abusive key does not consume another key\'s capacity', async () => {
    const abusive = buildApp({ id: 'key_abusive', tier: 'free' });
    const victim = buildApp({ id: 'key_victim', tier: 'free' });
    const max = config.apiKeyRateLimit.tiers.free;

    for (let i = 0; i <= max; i += 1) {
      await request(abusive).get('/test');
    }
    const abusiveBlocked = await request(abusive).get('/test');
    const victimRes = await request(victim).get('/test');

    expect(abusiveBlocked.status).toBe(429);
    expect(victimRes.status).toBe(200);
    expect(victimRes.headers['x-ratelimit-remaining']).toBe(String(max - 1));
  });

  test('sets the bucket expiry only when the bucket is first created', async () => {
    const app = buildApp({ id: 'key_expire', tier: 'free' });

    await request(app).get('/test');
    await request(app).get('/test');

    expect(redis.incr).toHaveBeenCalledTimes(2);
    expect(redis.expire).toHaveBeenCalledTimes(1);
    expect(redis.expire.mock.calls[0][1]).toBe(config.apiKeyRateLimit.windowSeconds);
  });

  test('passes unauthenticated requests through untouched', async () => {
    const app = buildApp(null);

    const res = await request(app).get('/test');

    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    expect(redis.incr).not.toHaveBeenCalled();
  });

  test('fails open when Redis is unreachable', async () => {
    redis.incr.mockRejectedValueOnce(new Error('connection refused'));
    const app = buildApp({ id: 'key_redis_down', tier: 'free' });

    const res = await request(app).get('/test');

    expect(res.status).toBe(200);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Per-key rate limit fail-open due to cache error',
      expect.objectContaining({ error: 'connection refused' }),
    );
  });

  test('escalates to error level after three consecutive Redis failures', async () => {
    redis.incr.mockRejectedValue(new Error('still down'));
    const app = buildApp({ id: 'key_persistent_failure', tier: 'free' });

    await request(app).get('/test');
    await request(app).get('/test');
    await request(app).get('/test');

    expect(mockLogger.error).toHaveBeenCalledWith(
      'Per-key rate limit disabled — Redis error persists',
      expect.objectContaining({ consecutive_failures: 3 }),
    );
  });

  test('never logs the raw API key when a limit is exceeded', async () => {
    const app = buildApp({ id: 'key_logged', tier: 'free', key_hash: 'sensitive-hash' });
    const max = config.apiKeyRateLimit.tiers.free;

    for (let i = 0; i <= max; i += 1) {
      await request(app).get('/test');
    }

    const logged = mockLogger.warn.mock.calls
      .filter(([message]) => message === 'API key rate limit exceeded');
    expect(logged.length).toBeGreaterThan(0);
    expect(logged[0][1]).toEqual(expect.objectContaining({ key_id: 'key_logged', tier: 'free' }));
    expect(JSON.stringify(logged[0][1])).not.toContain('sensitive-hash');
  });
});
