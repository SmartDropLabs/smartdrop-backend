'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../src/services/cache', () => ({
  isConnected: () => true,
  disconnect: jest.fn(),
  getConcurrencyStats: () => ({ active: 0, waiting: 0, available: 50, max: 50 }),
  getCommandQueueLength: () => 0,
  getClient: () => ({
    incr: async () => 1,
    expire: async () => 1,
  }),
}));

const {
  requestIdMiddleware,
  requestContext,
  getRequestId,
  getRequestIdHeaders,
  addRequestIdHeaderInterceptor,
  runWithRequestId,
  bindRequestId,
} = require('../src/middleware/requestId');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_OR_REQ_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^req_[0-9a-zA-Z_-]+$/i;

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
  test('sets X-Request-ID and X-Correlation-ID response header on every response', async () => {
    const app = buildTestApp(() => {});

    const res = await request(app).get('/test');

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-correlation-id']).toBeDefined();
    expect(res.headers['x-request-id']).toBe(res.headers['x-correlation-id']);
    expect(res.headers['x-request-id']).toMatch(UUID_OR_REQ_RE);
  });

  test('attaches the same ID to req.id, req.correlationId and the response headers', async () => {
    let capturedReqId;
    let capturedCorrelationId;
    const app = buildTestApp((req) => {
      capturedReqId = req.id;
      capturedCorrelationId = req.correlationId;
    });

    const res = await request(app).get('/test');

    expect(capturedReqId).toBe(res.headers['x-request-id']);
    expect(capturedCorrelationId).toBe(res.headers['x-correlation-id']);
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

  test('background work started by request retains correlation ID via runWithRequestId / bindRequestId', async () => {
    let backgroundLoggedId;
    const app = buildTestApp((req) => {
      const boundTask = bindRequestId(() => {
        backgroundLoggedId = getRequestId();
      });
      boundTask();
    });

    const res = await request(app).get('/test');
    expect(backgroundLoggedId).toBe(res.headers['x-request-id']);
  });
});

describe('downstream requestId headers', () => {
  test('returns no header outside a request context', () => {
    expect(getRequestId()).toBeNull();
    expect(getRequestIdHeaders()).toEqual({});
  });

  test('returns the active request ID for downstream requests', async () => {
    await requestContext.run({ requestId: 'req_downstream_123', correlationId: 'req_downstream_123' }, async () => {
      expect(getRequestId()).toBe('req_downstream_123');
      expect(getRequestIdHeaders()['X-Request-ID']).toBe('req_downstream_123');
      expect(getRequestIdHeaders()['X-Correlation-ID']).toBe('req_downstream_123');
    });
  });

  test('adds the active request ID through an HTTP client interceptor', async () => {
    let interceptor;
    const httpClient = {
      interceptors: {
        request: {
          use: jest.fn((handler) => {
            interceptor = handler;
          }),
        },
      },
    };

    expect(addRequestIdHeaderInterceptor(httpClient)).toBe(httpClient);

    const requestConfig = await requestContext.run(
      { requestId: 'req_intercepted_123', correlationId: 'req_intercepted_123' },
      () => interceptor({ headers: { Accept: 'application/json' } })
    );

    expect(requestConfig.headers).toEqual({
      Accept: 'application/json',
      'X-Request-ID': 'req_intercepted_123',
      'X-Correlation-ID': 'req_intercepted_123',
    });
  });
});

describe('logger requestId correlation and redaction', () => {
  let writeSpy;

  beforeEach(() => {
    jest.resetModules();
    process.env.LOG_FORMAT = 'json';
    process.env.LOG_LEVEL = 'info';
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

  test('log output includes matching requestId and correlationId for a given request', async () => {
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
    expect(parsed.correlationId).toBe(res.headers['x-correlation-id']);
  });

  test('background tasks outside request context log with requestId system', () => {
    const logger = require('../src/logger');

    logger.info('Background task running');

    const logLine = findLogLine('Background task running');
    expect(logLine).toBeDefined();
    const parsed = JSON.parse(logLine);
    expect(parsed.requestId).toBe('system');
  });

  test('redacts sensitive headers, cookies, passwords, tokens and request bodies from logs', async () => {
    const { requestIdMiddleware: middleware } = require('../src/middleware/requestId');
    const logger = require('../src/logger');

    const app = express();
    app.use(middleware);
    app.post('/auth-test', (req, res) => {
      logger.info('User authenticated', {
        headers: {
          authorization: 'Bearer super-secret-jwt-token',
          cookie: 'session_id=secret-session-cookie',
        },
        body: {
          password: 'TopSecretPassword123!',
          token: 'sensitive-api-token',
        },
        url: 'https://example.com/api?token=query-secret-token&user=alice',
      });
      res.json({ ok: true });
    });

    await request(app).post('/auth-test');
    const logLine = findLogLine('User authenticated');

    expect(logLine).toBeDefined();
    const parsed = JSON.parse(logLine);
    expect(parsed.headers.authorization).toBe('[REDACTED]');
    expect(parsed.headers.cookie).toBe('[REDACTED]');
    expect(parsed.body).toBe('[REDACTED]');
    expect(parsed.url).toContain('token=[REDACTED]');
    expect(logLine).not.toContain('super-secret-jwt-token');
    expect(logLine).not.toContain('secret-session-cookie');
    expect(logLine).not.toContain('TopSecretPassword123!');
    expect(logLine).not.toContain('query-secret-token');
  });
});

describe('requestId on app routes', () => {
  test('health endpoint returns X-Request-ID and X-Correlation-ID header', async () => {
    jest.resetModules();
    const { app } = require('../src/index');

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-correlation-id']).toBeDefined();
  });
});

describe('requestId client-supplied correlation validation (#133 / #461)', () => {
  function buildApp() {
    const app = express();
    app.use(requestIdMiddleware);
    app.get('/echo', (req, res) => res.json({ ok: true }));
    app.post('/boom', (req, res) => {
      res.status(400).json({ error: { code: 'BAD', message: 'bad', request_id: req.id } });
    });
    return app;
  }

  test('honors a well-formed client X-Request-ID', async () => {
    const app = buildApp();
    const res = await request(app).get('/echo').set('X-Request-ID', 'client-corr-123_X');

    expect(res.headers['x-request-id']).toBe('client-corr-123_X');
    expect(res.headers['x-correlation-id']).toBe('client-corr-123_X');
    expect(res.body.request_id).toBe('client-corr-123_X');
    expect(res.body.correlation_id).toBe('client-corr-123_X');
  });

  test('honors a well-formed client X-Correlation-ID', async () => {
    const app = buildApp();
    const res = await request(app).get('/echo').set('X-Correlation-ID', 'corr-id-9988_A');

    expect(res.headers['x-request-id']).toBe('corr-id-9988_A');
    expect(res.headers['x-correlation-id']).toBe('corr-id-9988_A');
    expect(res.body.request_id).toBe('corr-id-9988_A');
    expect(res.body.correlation_id).toBe('corr-id-9988_A');
  });

  test('rejects an oversized incoming ID and generates a UUID instead', async () => {
    const app = buildApp();
    const huge = 'A'.repeat(200);
    const res = await request(app).get('/echo').set('X-Request-ID', huge);

    expect(res.headers['x-request-id']).not.toBe(huge);
    expect(res.headers['x-request-id'].length).toBeLessThan(200);
    expect(res.headers['x-request-id']).toMatch(UUID_OR_REQ_RE);
    expect(res.body.request_id).toBe(res.headers['x-request-id']);
  });

  test('rejects a malformed (disallowed-character) incoming ID and generates a UUID instead', async () => {
    const app = buildApp();
    const res = await request(app).get('/echo').set('X-Request-ID', 'evil.example.com/path\nINJECTION');

    expect(res.headers['x-request-id']).not.toBe('evil.example.com/path\nINJECTION');
    expect(res.headers['x-request-id']).toMatch(UUID_OR_REQ_RE);
  });

  test('a rejected client value is not reflected into error response bodies', async () => {
    const app = buildApp();
    const res = await request(app).post('/boom').set('X-Request-ID', '::malformed::');

    expect(res.body.error.request_id).toMatch(UUID_OR_REQ_RE);
    expect(res.body.error.request_id).not.toBe('::malformed::');
  });
});