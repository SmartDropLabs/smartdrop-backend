'use strict';

/**
 * Structured error code registry (issue #253).
 */

const express = require('express');
const request = require('supertest');
const AppError = require('../src/errors/AppError');
const { errorHandler, notFoundHandler } = require('../src/middleware/errorHandler');

jest.mock('../src/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../src/services/errorTracker', () => ({ captureException: jest.fn() }));

function buildApp(handler) {
  const app = express();
  app.get('/boom', handler);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('error code registry', () => {
  test('every registered code maps to a valid HTTP status', () => {
    for (const [code, meta] of Object.entries(AppError.codes)) {
      expect(typeof meta.statusCode).toBe('number');
      expect(meta.statusCode).toBeGreaterThanOrEqual(400);
      expect(meta.statusCode).toBeLessThan(600);
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  test('the registry is frozen so codes cannot be added at runtime', () => {
    expect(Object.isFrozen(AppError.codes)).toBe(true);
  });

  test('isKnownCode distinguishes registered from unregistered codes', () => {
    expect(AppError.isKnownCode('VALIDATION_ERROR')).toBe(true);
    expect(AppError.isKnownCode('WEBHOOK_NOT_FOUND')).toBe(true);
    expect(AppError.isKnownCode('NOT_A_REAL_CODE')).toBe(false);
  });

  test('constructing an AppError with an unregistered code throws', () => {
    expect(() => new AppError('MADE_UP_CODE', 'nope')).toThrow(/Unknown application error code/);
  });

  test('status defaults to the registry entry when not passed explicitly', () => {
    expect(new AppError('WEBHOOK_NOT_FOUND', 'gone').statusCode).toBe(404);
    expect(new AppError('RATE_LIMITED', 'slow down').statusCode).toBe(429);
    expect(new AppError('FORBIDDEN', 'no').statusCode).toBe(403);
  });

  test('resource-specific codes exist for the resources clients act on', () => {
    for (const code of [
      'WEBHOOK_NOT_FOUND',
      'AIRDROP_NOT_FOUND',
      'ALERT_NOT_FOUND',
      'API_KEY_NOT_FOUND',
      'AIRDROP_NOT_INDEXED',
    ]) {
      expect(AppError.isKnownCode(code)).toBe(true);
    }
  });

  test('FORBIDDEN is registered, not just referenced by the handler', () => {
    // errorHandler maps status 403 to FORBIDDEN; before this it was not in
    // the registry, so that path emitted a code no client could rely on.
    expect(AppError.isKnownCode('FORBIDDEN')).toBe(true);
  });
});

describe('error responses', () => {
  test('carry a machine-readable code alongside the message', async () => {
    const app = buildApp((_req, _res, next) =>
      next(new AppError('WEBHOOK_NOT_FOUND', 'Webhook not found', 404)));

    const res = await request(app).get('/boom');

    expect(res.status).toBe(404);
    expect(res.body.error).toEqual(expect.objectContaining({
      code: 'WEBHOOK_NOT_FOUND',
      message: 'Webhook not found',
    }));
  });

  test('include structured details when the error carries them', async () => {
    const app = buildApp((_req, _res, next) =>
      next(new AppError('CSV_MISSING_COLUMNS', 'bad csv', 400, { missing_columns: ['amount'] })));

    const res = await request(app).get('/boom');

    expect(res.body.error.details).toEqual({ missing_columns: ['amount'] });
  });

  test('an unregistered code is reported as INTERNAL_ERROR rather than leaked', async () => {
    const app = buildApp((_req, _res, next) => {
      const err = new Error('weird');
      err.statusCode = 418;
      next(err);
    });

    const res = await request(app).get('/boom');

    expect(AppError.isKnownCode(res.body.error.code)).toBe(true);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  test('an unmatched route returns a coded 404', async () => {
    const app = buildApp((_req, res) => res.json({ ok: true }));

    const res = await request(app).get('/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  test('an unexpected throw does not leak the internal message to the client', async () => {
    const app = buildApp(() => { throw new Error('connection string postgres://user:pw@host'); });

    const res = await request(app).get('/boom');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('postgres://');
  });
});
