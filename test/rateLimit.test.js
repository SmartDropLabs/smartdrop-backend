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

const buildRateLimit = require('../src/middleware/rateLimit');
const { errorHandler } = require('../src/middleware/errorHandler');

function buildApp(limiter) {
  const app = express();
  app.use(limiter);
  app.get('/test', (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

beforeEach(() => reset());

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

  test('throws when configured with invalid options', () => {
    expect(() => buildRateLimit({ windowSeconds: 0, max: 10, keyPrefix: 'x' })).toThrow();
    expect(() => buildRateLimit({ windowSeconds: 60, max: 0, keyPrefix: 'x' })).toThrow();
    expect(() => buildRateLimit({ windowSeconds: 60, max: 10 })).toThrow();
  });
});
