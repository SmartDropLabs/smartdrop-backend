'use strict';

const express = require('express');
const request = require('supertest');
const { cacheControl } = require('../src/middleware/cacheControl');
const { buildRateLimit } = require('../src/middleware/rateLimit');
const buildCorsMiddleware = require('../src/middleware/cors');
const {
  createCsrfProtectionMiddleware,
  generateCsrfToken,
  verifyCsrfToken,
} = require('../src/middleware/csrf');
const cache = require('../src/services/cache');

describe('Middleware security and performance (#705, #706, #707, #708)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('#705 — cacheControl for authenticated endpoints', () => {
    it('sets Cache-Control: private, no-store when req.user is present even on cacheable paths', () => {
      const mw = cacheControl();
      const headers = {};
      const req = { path: '/api/airdrops', user: { id: 'user-1' } };
      const res = { setHeader: (k, v) => { headers[k] = v; } };
      const next = jest.fn();

      mw(req, res, next);

      expect(headers['Cache-Control']).toBe('private, no-store');
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('preserves public caching for unauthenticated cacheable paths', () => {
      const mw = cacheControl();
      const headers = {};
      const req = { path: '/api/airdrops' };
      const res = { setHeader: (k, v) => { headers[k] = v; } };
      const next = jest.fn();

      mw(req, res, next);

      expect(headers['Cache-Control']).toContain('public, max-age=60');
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('#706 — rateLimit response headers', () => {
    it('sets X-RateLimit-Limit, X-RateLimit-Remaining, and X-RateLimit-Reset headers', async () => {
      jest.spyOn(cache, 'getClient').mockReturnValue({
        incr: jest.fn().mockResolvedValue(2),
        expire: jest.fn().mockResolvedValue(1),
        get: jest.fn().mockResolvedValue('0'),
      });

      const mw = buildRateLimit({ windowSeconds: 60, max: 10, keyPrefix: 'test-706' });
      const headers = {};
      const req = { ip: '127.0.0.1' };
      const res = { setHeader: (k, v) => { headers[k] = v; } };
      const next = jest.fn();

      await mw(req, res, next);

      expect(headers['X-RateLimit-Limit']).toBe('10');
      expect(headers['X-RateLimit-Remaining']).toBe('8');
      expect(Number(headers['X-RateLimit-Reset'])).toBeGreaterThan(0);
      expect(next).toHaveBeenCalledWith();
    });
  });

  describe('#707 — CORS preflight caching', () => {
    it('returns Access-Control-Max-Age header on OPTIONS preflight requests', async () => {
      const app = express();
      app.use(buildCorsMiddleware(['https://app.example.com'], { nodeEnv: 'test' }));
      app.get('/api/test', (_req, res) => res.json({ ok: true }));

      const res = await request(app)
        .options('/api/test')
        .set('Origin', 'https://app.example.com')
        .set('Access-Control-Request-Method', 'POST');

      expect(res.status).toBe(204);
      expect(res.headers['access-control-max-age']).toBe('86400');
    });
  });

  describe('#708 — CSRF token rotation', () => {
    it('rotates CSRF token via cookie and X-CSRF-Token header when token age exceeds TTL', async () => {
      const secret = 'test-secret-708';
      const oldIssuedAt = Date.now() - 60_000;
      const staleToken = generateCsrfToken('sess-1', secret, oldIssuedAt);
      expect(verifyCsrfToken(staleToken, 'sess-1', secret)).toBe(true);

      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.session = { id: 'sess-1' };
        next();
      });
      app.use(
        createCsrfProtectionMiddleware({
          allowedOrigins: ['https://app.example.com'],
          secret,
          tokenTtlMs: 10_000,
        }),
      );
      app.post('/api/action', (_req, res) => res.status(200).json({ ok: true }));

      const res = await request(app)
        .post('/api/action')
        .set('Origin', 'https://app.example.com')
        .set('X-CSRF-Token', staleToken);

      expect(res.status).toBe(200);
      expect(res.headers['x-csrf-token']).toBeDefined();
      expect(res.headers['x-csrf-token']).not.toBe(staleToken);
      expect(verifyCsrfToken(res.headers['x-csrf-token'], 'sess-1', secret)).toBe(true);
      expect(res.headers['set-cookie']).toBeDefined();
    });
  });
});
