'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../src/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const logger = require('../src/logger');
const requestLoggerMiddleware = require('../src/middleware/requestLogger');

function buildApp() {
  const app = express();
  app.use(requestLoggerMiddleware);
  app.get('/ok', (req, res) => res.json({ ok: true }));
  app.get('/client-error', (req, res) => res.status(404).json({ error: 'not found' }));
  app.get('/server-error', (req, res) => res.status(500).json({ error: 'boom' }));
  app.get('/query', (req, res) => res.json({ ok: true }));
  return app;
}

describe('requestLogger middleware', () => {
  beforeEach(() => jest.clearAllMocks());

  test('logs method, path, status code, and a numeric duration on success', async () => {
    const app = buildApp();
    await request(app).get('/ok');

    expect(logger.info).toHaveBeenCalledTimes(1);
    const [message, meta] = logger.info.mock.calls[0];
    expect(message).toBe('HTTP request');
    expect(meta.method).toBe('GET');
    expect(meta.path).toBe('/ok');
    expect(meta.statusCode).toBe(200);
    expect(typeof meta.durationMs).toBe('number');
    expect(meta.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('logs a 4xx response at warn level', async () => {
    const app = buildApp();
    await request(app).get('/client-error');

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn.mock.calls[0][1].statusCode).toBe(404);
  });

  test('logs a 5xx response at error level', async () => {
    const app = buildApp();
    await request(app).get('/server-error');

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][1].statusCode).toBe(500);
  });

  test('does not include the query string in the logged path', async () => {
    const app = buildApp();
    await request(app).get('/query?api_key=super-secret-value');

    const meta = logger.info.mock.calls[0][1];
    expect(meta.path).toBe('/query');
    expect(JSON.stringify(meta)).not.toContain('super-secret-value');
  });

  describe('slow request warning (#244)', () => {
    test('does not log a slow-request warning for a fast request', async () => {
      const app = buildApp();
      await request(app).get('/ok');

      const slowCall = logger.warn.mock.calls.find(([message]) => message === 'Slow request detected');
      expect(slowCall).toBeUndefined();
    });

    test('logs a distinct "Slow request detected" warning when duration exceeds the threshold', async () => {
      const hrtimeBigintSpy = jest.spyOn(process.hrtime, 'bigint');
      // First call is the middleware's startedAt, second is at res.on('finish') —
      // 1.5s apart in nanoseconds, well past the default 1000ms threshold.
      hrtimeBigintSpy.mockReturnValueOnce(0n).mockReturnValueOnce(1_500_000_000n);

      const app = buildApp();
      await request(app).get('/ok');

      hrtimeBigintSpy.mockRestore();

      const slowCall = logger.warn.mock.calls.find(([message]) => message === 'Slow request detected');
      expect(slowCall).toBeDefined();
      expect(slowCall[1]).toMatchObject({
        method: 'GET',
        path: '/ok',
        statusCode: 200,
        thresholdMs: 1000,
      });
      expect(slowCall[1].durationMs).toBeCloseTo(1500, 0);

      // The routine per-request log line still fires as normal, unaffected.
      expect(logger.info).toHaveBeenCalledTimes(1);
    });

    test('a slow request that also errors logs both the routine error line and the slow warning', async () => {
      const hrtimeBigintSpy = jest.spyOn(process.hrtime, 'bigint');
      hrtimeBigintSpy.mockReturnValueOnce(0n).mockReturnValueOnce(2_000_000_000n);

      const app = buildApp();
      await request(app).get('/server-error');

      hrtimeBigintSpy.mockRestore();

      expect(logger.error).toHaveBeenCalledTimes(1);
      const slowCall = logger.warn.mock.calls.find(([message]) => message === 'Slow request detected');
      expect(slowCall).toBeDefined();
      expect(slowCall[1].statusCode).toBe(500);
    });
  });
});
