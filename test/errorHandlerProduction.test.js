'use strict';

/**
 * #619 — in production a server error must not leak its message, details or
 * any stack trace to the client.
 */

const express = require('express');
const request = require('supertest');

jest.mock('../src/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('../src/services/errorTracker', () => ({
  captureException: jest.fn(),
}));

const AppError = require('../src/errors/AppError');
const { errorHandler, sanitizeDetails } = require('../src/middleware/errorHandler');

function buildApp(err) {
  const app = express();
  app.get('/boom', (_req, _res, next) => next(err));
  app.use(errorHandler);
  return app;
}

describe('errorHandler in production (#619)', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('hides the message and details of a 5xx AppError', async () => {
    process.env.NODE_ENV = 'production';
    const err = new AppError('INTERNAL_ERROR', 'query failed at /app/src/db/pool.js:42', 500, {
      query: 'SELECT secret FROM keys',
    });

    const res = await request(buildApp(err)).get('/boom').set('Accept', 'application/json');

    expect(res.status).toBe(500);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('pool.js');
    expect(body).not.toContain('SELECT secret');
    expect(res.body.error.details).toBeUndefined();
  });

  it('never includes a stack for a plain thrown Error', async () => {
    process.env.NODE_ENV = 'production';
    const err = new Error('kaboom');

    const res = await request(buildApp(err)).get('/boom').set('Accept', 'application/json');

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.js:\d+/);
    expect(res.body.error.stack).toBeUndefined();
  });

  it('still returns client-error details outside of 5xx', async () => {
    process.env.NODE_ENV = 'production';
    const err = new AppError('VALIDATION_ERROR', 'Bad input', 400, { field: 'email' });

    const res = await request(buildApp(err)).get('/boom').set('Accept', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual({ field: 'email' });
  });
});

describe('sanitizeDetails (#619)', () => {
  it('drops nested stack properties and sanitizes strings', () => {
    const cause = new Error('inner');
    const out = sanitizeDetails({
      cause: { message: 'inner', stack: cause.stack },
      list: [{ stack: 'at x (/a/b.js:1:2)', ok: true }],
      note: 'see /srv/app/index.js:10',
    });

    expect(out.cause).toEqual({ message: 'inner' });
    expect(out.list).toEqual([{ ok: true }]);
    expect(out.note).not.toContain('index.js:10');
  });
});
