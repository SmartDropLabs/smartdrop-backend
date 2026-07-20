const request = require('supertest');
const express = require('express');
const AppError = require('../src/errors/AppError');
const { requestIdMiddleware } = require('../src/middleware/requestId');
const { errorHandler, notFoundHandler } = require('../src/middleware/errorHandler');
const buildRateLimit = require('../src/middleware/rateLimit');
const cache = require('../src/services/cache');

jest.mock('../src/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('../src/services/cache', () => ({
  getClient: jest.fn(),
}));

function buildApp(route) {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  route(app);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('structured error responses', () => {
  test.each([
    ['VALIDATION_ERROR', 400],
    ['UNAUTHORIZED', 401],
    ['NOT_FOUND', 404],
    ['PAYLOAD_TOO_LARGE', 413],
    ['UPSTREAM_ERROR', 502],
    ['INTERNAL_ERROR', 500],
  ])('returns standard shape for %s', async (code, status) => {
    const app = buildApp((app) => {
      app.get('/boom', (_req, _res, next) => next(new AppError(code, `${code} message`, status, { field: 'x' })));
    });

    const res = await request(app).get('/boom');

    expect(res.status).toBe(status);
    expect(res.body).toEqual({
      error: {
        code,
        message: `${code} message`,
        details: { field: 'x' },
        request_id: expect.stringMatching(/^req_/),
      }
    });
    expect(res.headers['x-request-id']).toBe(res.body.error.request_id);
  });

  test('omits stack traces for unhandled errors', async () => {
    const app = buildApp((app) => {
      app.get('/boom', () => { throw new Error('secret stack details'); });
    });

    const res = await request(app).get('/boom');

    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      request_id: expect.stringMatching(/^req_/)
    });
    expect(JSON.stringify(res.body)).not.toContain('secret stack details');
    expect(JSON.stringify(res.body)).not.toContain('stack');
  });

  test('returns a structured 413 when the JSON body limit is exceeded', async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.use(express.json({ limit: 10 }));
    app.post('/payload', (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);

    const res = await request(app).post('/payload').send({ value: 'too large' });

    expect(res.status).toBe(413);
    expect(res.body.error).toEqual({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request body is too large',
      request_id: expect.stringMatching(/^req_/),
    });
  });

  test('adds request_id to success responses', async () => {
    const app = buildApp((app) => {
      app.get('/ok', (_req, res) => res.json({ ok: true }));
    });

    const res = await request(app).get('/ok');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, request_id: expect.stringMatching(/^req_/) });
  });

  test('returns structured 404 for undefined routes', async () => {
    const app = buildApp(() => {});
    const res = await request(app).get('/missing');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.request_id).toMatch(/^req_/);
  });

  test('returns RATE_LIMITED shape', async () => {
    cache.getClient.mockReturnValue({ incr: jest.fn().mockResolvedValue(2), expire: jest.fn().mockResolvedValue(1) });
    const app = buildApp((app) => {
      app.get('/limited', buildRateLimit({ windowSeconds: 60, max: 1, keyPrefix: 'test' }), (_req, res) => res.json({ ok: true }));
    });

    const res = await request(app).get('/limited');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.body.error.details).toEqual({ limit: 1, window_seconds: 60 });
  });
});
