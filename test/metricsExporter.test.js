'use strict';

const express = require('express');
const request = require('supertest');
const {
  Registry,
  escapeLabelValue,
  formatLabels,
} = require('../src/metrics/registry');
const {
  registry,
  metricsHandler,
  requestMetricsMiddleware,
  httpRequestsTotal,
  httpRequestDuration,
} = require('../src/metrics');
const { errorHandler } = require('../src/middleware/errorHandler');

describe('Issue #467: Prometheus Metrics Exporter', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    registry.reset();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('1. Exposition Format & Content-Type', () => {
    it('returns text/plain; version=0.0.4; charset=utf-8 with valid HELP and TYPE lines', async () => {
      process.env.METRICS_ENABLED = 'true';
      delete process.env.METRICS_AUTH_TOKEN;

      const app = express();
      app.get('/metrics', metricsHandler);

      const res = await request(app).get('/metrics');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
      expect(res.text).toContain('# HELP http_requests_total');
      expect(res.text).toContain('# TYPE http_requests_total counter');
      expect(res.text).toContain('# HELP http_request_duration_seconds');
      expect(res.text).toContain('# TYPE http_request_duration_seconds histogram');
    });

    it('correctly escapes label values with quotes, backslashes, and newlines', () => {
      const reg = new Registry();
      const counter = reg.counter('test_escape_total', 'Test escaping');

      counter.inc({ reason: 'quotes " and \\ and \n newline' });
      const serialized = reg.serialize();

      expect(serialized).toContain('reason="quotes \\" and \\\\ and \\n newline"');
    });
  });

  describe('2. HTTP Metrics Tracking & Route Template Cardinality', () => {
    function createTestApp() {
      const app = express();
      app.use(requestMetricsMiddleware);

      const router = express.Router();
      router.get('/airdrops/:id', (req, res) => res.json({ id: req.params.id }));
      router.post('/airdrops', (req, res) => res.status(201).json({ created: true }));

      app.use('/v1', router);
      app.get('/metrics', metricsHandler);

      app.use((req, res) => res.status(404).json({ error: 'not found' }));
      return app;
    }

    it('increments counters and histograms for handled requests using the route template', async () => {
      const app = createTestApp();

      // Request a parameterized route with user ID
      const res = await request(app).get('/v1/airdrops/airdrop-uuid-12345');
      expect(res.status).toBe(200);

      const metricsRes = await request(app).get('/metrics');
      expect(metricsRes.text).toContain(
        'http_requests_total{method="GET",route="/v1/airdrops/:id",status="200"} 1'
      );
      expect(metricsRes.text).toContain(
        'http_request_duration_seconds_count{method="GET",route="/v1/airdrops/:id",status="200"} 1'
      );

      // Ensures the specific ID was not incorporated into the route label (bounded cardinality)
      expect(metricsRes.text).not.toContain('airdrop-uuid-12345');
    });

    it('labels unmatched routes with the fixed label "unmatched"', async () => {
      const app = createTestApp();

      const res = await request(app).get('/v1/non-existent-random-path');
      expect(res.status).toBe(404);

      const metricsRes = await request(app).get('/metrics');
      expect(metricsRes.text).toContain(
        'http_requests_total{method="GET",route="unmatched",status="404"} 1'
      );
    });

    it('does NOT count /metrics requests to avoid recursion and scraping distortion', async () => {
      const app = createTestApp();

      await request(app).get('/metrics');
      await request(app).get('/metrics');

      const metricsRes = await request(app).get('/metrics');
      expect(metricsRes.text).not.toContain('route="/metrics"');
    });
  });

  describe('3. Rejection by Earlier Middleware Counting', () => {
    it('counts requests that are rejected by earlier middleware (e.g. rate-limit or auth)', async () => {
      const app = express();
      // Metrics middleware sits first
      app.use(requestMetricsMiddleware);

      // Simulating rejecting middleware (e.g. 429 rate limit or 403 forbidden)
      app.use('/api/rejected', (req, res) => {
        return res.status(429).json({ error: 'Rate limit exceeded' });
      });

      app.get('/metrics', metricsHandler);

      const res = await request(app).get('/api/rejected');
      expect(res.status).toBe(429);

      const metricsRes = await request(app).get('/metrics');
      expect(metricsRes.text).toContain(
        'http_requests_total{method="GET",route="unmatched",status="429"} 1'
      );
    });
  });

  describe('4. Protection and Authentication', () => {
    it('returns 404 when metrics are disabled via METRICS_ENABLED=false', async () => {
      process.env.METRICS_ENABLED = 'false';

      const app = express();
      app.get('/metrics', metricsHandler);

      const res = await request(app).get('/metrics');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('rejects missing or incorrect credentials when METRICS_AUTH_TOKEN is configured', async () => {
      process.env.METRICS_ENABLED = 'true';
      process.env.METRICS_AUTH_TOKEN = 'secret-metrics-token-123';

      const app = express();
      app.get('/metrics', metricsHandler);

      // Missing token
      const noAuthRes = await request(app).get('/metrics');
      expect(noAuthRes.status).toBe(401);

      // Wrong token
      const wrongAuthRes = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer wrong-token');
      expect(wrongAuthRes.status).toBe(401);

      // Valid token
      const validAuthRes = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer secret-metrics-token-123');
      expect(validAuthRes.status).toBe(200);
      expect(validAuthRes.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    });

    it('denies requests from unauthorized IPs when METRICS_ALLOWED_IPS is configured', async () => {
      process.env.METRICS_ENABLED = 'true';
      process.env.METRICS_AUTH_TOKEN = 'token';
      process.env.METRICS_ALLOWED_IPS = '10.0.0.1,10.0.0.2';

      const app = express();
      app.get('/metrics', metricsHandler);

      const res = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer token');

      // Supertest default remote address is 127.0.0.1, not in 10.0.0.1
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('5. Data Privacy & Leaks', () => {
    it('contains no secret tokens, passwords, or personal email addresses in metric output', async () => {
      process.env.METRICS_ENABLED = 'true';
      delete process.env.METRICS_AUTH_TOKEN;

      const app = express();
      app.use(requestMetricsMiddleware);
      app.get('/v1/users/:id', (req, res) => res.json({ id: req.params.id }));
      app.get('/metrics', metricsHandler);

      await request(app)
        .get('/v1/users/alice@example.com?secret_token=topsecret123')
        .set('Authorization', 'Bearer my-private-token');

      const metricsRes = await request(app).get('/metrics');
      expect(metricsRes.text).not.toContain('alice@example.com');
      expect(metricsRes.text).not.toContain('topsecret123');
      expect(metricsRes.text).not.toContain('my-private-token');
    });
  });
});
