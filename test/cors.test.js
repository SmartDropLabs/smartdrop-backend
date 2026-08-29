'use strict';

const express = require('express');
const request = require('supertest');
const buildCorsMiddleware = require('../src/middleware/cors');

const ALLOWED = ['http://localhost:3000', 'https://app.smartdrop.io'];

function buildApp(allowedOrigins) {
  const app = express();
  app.use(buildCorsMiddleware(allowedOrigins));
  app.get('/test', (req, res) => res.json({ ok: true }));
  app.use((err, req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

describe('CORS allowed origins', () => {
  let app;
  beforeAll(() => { app = buildApp(ALLOWED); });

  test('allowed origin receives Access-Control-Allow-Origin header', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'http://localhost:3000');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  test('second allowed origin also receives CORS header', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://app.smartdrop.io');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.smartdrop.io');
  });

  test('credentials header is set for allowed origin', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'http://localhost:3000');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  test('preflight OPTIONS returns 204 with allowed methods', async () => {
    const res = await request(app)
      .options('/test')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-methods']).toMatch(/POST/);
  });

  test('preflight respects maxAge cache directive', async () => {
    const res = await request(app)
      .options('/test')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-max-age']).toBe('86400');
  });
});

describe('CORS rejected origins', () => {
  let app;
  beforeAll(() => { app = buildApp(ALLOWED); });

  test('unknown origin receives 403', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://evil.com');
    expect(res.status).toBe(403);
  });

  test('rejected origin includes the offending origin in the error message', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://evil.com');
    expect(res.status).toBe(403);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.message).toContain('https://evil.com');
    expect(res.body.error.message).toContain('not allowed');
  });

  test('rejected origin does not receive Access-Control-Allow-Origin', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://evil.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('subdomain of allowed origin is not automatically permitted', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://sub.app.smartdrop.io');
    expect(res.status).toBe(403);
  });
});

describe('CORS no-origin requests (server-to-server, curl)', () => {
  let app;
  beforeAll(() => { app = buildApp(ALLOWED); });

  test('request without Origin header is allowed through', async () => {
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('CORS_ALLOWED_ORIGINS config parsing', () => {
  test('dev default allows localhost:3000 and localhost:3001', () => {
    const original = process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.CORS_ALLOWED_ORIGINS;
    jest.resetModules();
    const config = require('../src/config');
    expect(config.corsAllowedOrigins).toContain('http://localhost:3000');
    expect(config.corsAllowedOrigins).toContain('http://localhost:3001');
    process.env.CORS_ALLOWED_ORIGINS = original;
  });

  test('parses comma-separated origins and trims whitespace', () => {
    const original = process.env.CORS_ALLOWED_ORIGINS;
    process.env.CORS_ALLOWED_ORIGINS = ' https://app.smartdrop.io , https://staging.smartdrop.io ';
    jest.resetModules();
    const config = require('../src/config');
    expect(config.corsAllowedOrigins).toEqual([
      'https://app.smartdrop.io',
      'https://staging.smartdrop.io',
    ]);
    if (original !== undefined) process.env.CORS_ALLOWED_ORIGINS = original;
    else delete process.env.CORS_ALLOWED_ORIGINS;
  });
});
