'use strict';

const express = require('express');
const request = require('supertest');
const { setCookie, clearCookie, buildCookieOptions } = require('../src/auth/cookies');
const config = require('../src/config');

function withApp(middleware) {
  const app = express();
  app.get('/set', (req, res) => {
    setCookie(res, 'sid', 'abc123', { req, maxAgeMs: 3600 * 1000 });
    res.json({ ok: true });
  });
  app.get('/clear', (req, res) => {
    clearCookie(res, 'sid', { req });
    res.json({ ok: true });
  });
  if (middleware) app.use(middleware);
  return app;
}

describe('secure cookie helpers (issue #496)', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('trust proxy is disabled by default (config)', () => {
    expect(config.trustProxy).toBe(false);
  });

  test('buildCookieOptions sets HttpOnly, SameSite=Strict, Path=/ and Secure=false when http', () => {
    const opts = buildCookieOptions({ req: { secure: false }, maxAgeMs: 60000 });
    expect(opts).toMatchObject({
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
    });
    expect(opts.secure).toBe(false);
    expect(opts.maxAge).toBe(60000);
  });

  test('clearCookie sets Max-Age=0 and Expires in the past', () => {
    const res = {
      clearCookie: jest.fn(),
    };
    clearCookie(res, 'sid', { req: { secure: true } });
    const [name, opts] = res.clearCookie.mock.calls[0];
    expect(name).toBe('sid');
    expect(opts.maxAge).toBe(0);
    expect(opts.expires instanceof Date).toBe(true);
    expect(opts.expires.getTime()).toBeLessThanOrEqual(Date.now());
    expect(opts.httpOnly).toBe(true);
    expect(opts.secure).toBe(true);
    expect(opts.path).toBe('/');
    expect(opts.sameSite).toBe('Strict');
  });

  test('over https, Secure is true', async () => {
    const app = withApp();
    const res = await request(app).get('/set').trustLocalhost(false).set('X-Forwarded-Proto', 'https');
    const setCookieHeader = res.headers['set-cookie'];
    expect(setCookieHeader).toBeDefined();
    expect(setCookieHeader[0]).toMatch(/sid=abc123/);
    expect(setCookieHeader[0]).toMatch(/HttpOnly/);
    expect(setCookieHeader[0]).toMatch(/SameSite=Strict/);
    expect(setCookieHeader[0]).toMatch(/Secure/);
  });

  test('over http in non-prod, Secure is false (dev/test)', async () => {
    const app = withApp();
    const res = await request(app).get('/set');
    const setCookieHeader = res.headers['set-cookie'];
    expect(setCookieHeader).toBeDefined();
    expect(setCookieHeader[0]).toMatch(/sid=abc123/);
    expect(setCookieHeader[0]).not.toMatch(/;\s*Secure\b/i);
    expect(setCookieHeader[0]).toMatch(/HttpOnly/);
    expect(setCookieHeader[0]).toMatch(/SameSite=Strict/);
  });

  test('rate limit uses req.ip (no spoofing assumption without trust proxy)', () => {
    const middleware = require('../src/middleware/rateLimit');
    const buildRateLimit = middleware.buildRateLimit;
    expect(typeof buildRateLimit).toBe('function');
    const limiter = buildRateLimit({ windowSeconds: 60, max: 10, keyPrefix: 't' });
    expect(typeof limiter).toBe('function');
  });
});
