'use strict';

const express = require('express');
const request = require('supertest');
const { createCacheMock } = require('./helpers/cacheMock');

const mockHelper = createCacheMock();
const { reset, redis } = mockHelper;

jest.mock('../src/services/cache', () => mockHelper.cacheMock);
const mockLogger = {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
};
jest.mock('../src/logger', () => mockLogger);

const buildRateLimit = require('../src/middleware/rateLimit');
const { errorHandler } = require('../src/middleware/errorHandler');

function buildApp(limiter) {
  const app = express();
  app.use(limiter);
  app.get('/test', (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  reset();
  Object.values(mockLogger).forEach((fn) => fn.mockClear());
});

describe('rateLimit middleware', () => {
  test('allows requests under the limit and sets rate-limit headers', async () => {
    const app = buildApp(buildRateLimit({ windowSeconds: 60, max: 3, keyPrefix: 't' }));
    const r1 = await request(app).get('/test');
    expect(r1.status).toBe(200);
    expect(r1.headers['x-ratelimit-limit']).toBe('3');
    expect(r1.headers['x-ratelimit-remaining']).toBe('2');
  });

  test('returns 429 once the limit is exceeded', async () => {
    const app = buildApp(buildRateLimit({ windowSeconds: 60, max: 2, keyPrefix: 'lim' }));
    await request(app).get('/test');
    await request(app).get('/test');
    const blocked = await request(app).get('/test');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatchObject({ code: 'RATE_LIMITED' });
    expect(blocked.body.error.details.retry_after_seconds).toBeGreaterThan(0);
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  test('sets Redis expiry only when a fixed-window bucket is first created', async () => {
    const app = buildApp(buildRateLimit({ windowSeconds: 30, max: 5, keyPrefix: 'expire' }));

    await request(app).get('/test');
    await request(app).get('/test');

    expect(redis.incr).toHaveBeenCalledTimes(2);
    expect(redis.expire).toHaveBeenCalledTimes(1);
    expect(redis.expire.mock.calls[0][1]).toBe(30);
  });

  test('fails open when Redis increment fails and logs the cache outage', async () => {
    redis.incr.mockRejectedValueOnce(new Error('redis down'));
    const app = buildApp(buildRateLimit({ windowSeconds: 60, max: 1, keyPrefix: 'open' }));

    const res = await request(app).get('/test');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Rate limit fail-open due to cache error',
      expect.objectContaining({ keyPrefix: 'open', error: 'redis down' })
    );
  });

  test('clears fail-open escalation state after a successful Redis call', async () => {
    const app = buildApp(buildRateLimit({ windowSeconds: 60, max: 3, keyPrefix: 'recover' }));
    redis.incr.mockRejectedValueOnce(new Error('first outage'));

    await request(app).get('/test');
    await request(app).get('/test');
    redis.incr.mockRejectedValueOnce(new Error('second outage'));
    await request(app).get('/test');

    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledTimes(2);
  });

  test('throws when configured with invalid options', () => {
    expect(() => buildRateLimit({ windowSeconds: 0, max: 10, keyPrefix: 'x' })).toThrow();
    expect(() => buildRateLimit({ windowSeconds: 60, max: 0, keyPrefix: 'x' })).toThrow();
    expect(() => buildRateLimit({ windowSeconds: 60, max: 10 })).toThrow();
  });
});
