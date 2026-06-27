'use strict';

const express = require('express');
const request = require('supertest');
const { requestIdMiddleware, requestContext } = require('../src/middleware/requestId');

function buildTestApp(onRequest) {
  const app = express();
  app.use(requestIdMiddleware);
  app.get('/test', (req, res) => {
    onRequest(req);
    res.json({ ok: true });
  });
  return app;
}

describe('requestId middleware', () => {
  test('sets X-Request-ID response header on every response', async () => {
    const app = buildTestApp(() => {});

    const res = await request(app).get('/test');

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  test('attaches the same ID to req.id and the response header', async () => {
    let capturedReqId;
    const app = buildTestApp((req) => {
      capturedReqId = req.id;
    });

    const res = await request(app).get('/test');

    expect(capturedReqId).toBe(res.headers['x-request-id']);
  });

  test('runs downstream handlers inside AsyncLocalStorage context', async () => {
    let storeRequestId;
    const app = buildTestApp((req) => {
      storeRequestId = requestContext.getStore()?.requestId;
      expect(storeRequestId).toBe(req.id);
    });

    const res = await request(app).get('/test');

    expect(storeRequestId).toBe(res.headers['x-request-id']);
  });
});

describe('logger requestId correlation', () => {
  let writeSpy;

  beforeEach(() => {
    jest.resetModules();
    process.env.LOG_FORMAT = 'json';
    process.env.LOG_LEVEL = 'info';
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk, _encoding, cb) => {
      if (typeof cb === 'function') cb();
      return true;
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  function findLogLine(message) {
    return writeSpy.mock.calls
      .map(([chunk]) => chunk.toString())
      .find((line) => line.includes(message));
  }

  test('log output includes matching requestId for a given request', async () => {
    const { requestIdMiddleware: middleware } = require('../src/middleware/requestId');
    const logger = require('../src/logger');

    const app = express();
    app.use(middleware);
    app.get('/test', (req, res) => {
      logger.info('Handling correlated request');
      res.json({ ok: true });
    });

    const res = await request(app).get('/test');
    const logLine = findLogLine('Handling correlated request');

    expect(logLine).toBeDefined();
    const parsed = JSON.parse(logLine);
    expect(parsed.requestId).toBe(res.headers['x-request-id']);
  });

  test('background tasks log with requestId system', () => {
    const logger = require('../src/logger');

    logger.info('Background task running');

    const logLine = findLogLine('Background task running');
    expect(logLine).toBeDefined();
    const parsed = JSON.parse(logLine);
    expect(parsed.requestId).toBe('system');
  });
});

describe('requestId on app routes', () => {
  test('health endpoint returns X-Request-ID header', async () => {
    jest.resetModules();
    const { app } = require('../src/index');

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeDefined();
  });
});