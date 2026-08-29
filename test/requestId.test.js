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
    expect(res.headers['x-request-id']).toMatch(/^req_[0-9a-zA-Z_-]+$/);
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
    // Winston's Console transport prefers `console._stdout` over
    // `process.stdout` directly (see winston/lib/winston/transports/console.js).
    // Depending on test run order, Jest's per-file console can end up wrapping
    // a different stream object than `process.stdout`, so spy on whichever one
    // Winston will actually call.
    const target = console._stdout || process.stdout;
    writeSpy = jest.spyOn(target, 'write').mockImplementation((chunk, _encoding, cb) => {
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

describe('requestId client-supplied X-Request-ID validation (#133)', () => {
  function buildApp() {
    const app = express();
    app.use(requestIdMiddleware);
    app.get('/echo', (req, res) => res.json({ ok: true }));
    app.post('/boom', (req, res) => {
      res.status(400).json({ error: { code: 'BAD', message: 'bad', request_id: req.id } });
    });
    return app;
  }

  test('honors a well-formed, reasonably-sized client X-Request-ID', async () => {
    const app = buildApp();
    const res = await request(app).get('/echo').set('X-Request-ID', 'client-corr-123_X');

    expect(res.headers['x-request-id']).toBe('client-corr-123_X');
    expect(res.body.request_id).toBe('client-corr-123_X');
  });

  test('rejects an oversized X-Request-ID and generates a server ID instead', async () => {
    const app = buildApp();
    // Exceeds MAX_REQUEST_ID_LENGTH (128) but stays within Node's header-size
    // limit so the server actually receives and re-evaluates it.
    const huge = 'A'.repeat(200);
    const res = await request(app).get('/echo').set('X-Request-ID', huge);

    expect(res.headers['x-request-id']).not.toBe(huge);
    expect(res.headers['x-request-id'].length).toBeLessThan(200);
    expect(res.headers['x-request-id']).toMatch(/^req_[0-9A-Za-z_-]+$/);
    expect(res.body.request_id).toBe(res.headers['x-request-id']);
  });

  test('rejects a malformed (disallowed-character) X-Request-ID and generates a server ID instead', async () => {
    const app = buildApp();
    const res = await request(app).get('/echo').set('X-Request-ID', 'evil.example.com/path');

    expect(res.headers['x-request-id']).not.toBe('evil.example.com/path');
    expect(res.headers['x-request-id']).toMatch(/^req_[0-9A-Za-z_-]+$/);
  });

  test('a rejected client value is not reflected into error response bodies', async () => {
    const app = buildApp();
    const res = await request(app).post('/boom').set('X-Request-ID', '::malformed::');

    expect(res.body.error.request_id).toMatch(/^req_[0-9A-Za-z_-]+$/);
    expect(res.body.error.request_id).not.toBe('::malformed::');
  });
});