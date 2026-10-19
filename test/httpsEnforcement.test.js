'use strict';

const express = require('express');
const request = require('supertest');
const {
  createHttpsEnforcementMiddleware,
  buildHstsHeader,
  resolveRedirectHost,
} = require('../src/middleware/httpsEnforcement');
const { errorHandler } = require('../src/middleware/errorHandler');

describe('Issue #468: HTTPS Enforcement and HSTS Headers', () => {
  function createApp(options = {}) {
    const {
      httpsConfig = {
        enforce: true,
        host: 'api.smartdrop.example.com',
        allowedHosts: ['api.smartdrop.example.com', 'smartdrop.io'],
        hstsMaxAge: 31536000,
        hstsIncludeSubDomains: true,
        hstsPreload: false,
      },
      trustProxy = false,
    } = options;

    const app = express();
    if (trustProxy !== undefined) {
      app.set('trust proxy', trustProxy);
    }

    app.use(createHttpsEnforcementMiddleware(httpsConfig));

    // Sample endpoints
    app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));
    app.get('/health/live', (req, res) => res.status(200).json({ status: 'live' }));
    app.get('/metrics', (req, res) => res.status(200).send('# metrics'));
    app.get('/v1/prices', (req, res) => res.status(200).json({ price: 100 }));
    app.post('/v1/airdrops', (req, res) => res.status(201).json({ created: true }));

    app.use(errorHandler);
    return app;
  }

  describe('1. Redirection and Method Preservation', () => {
    it('redirects an HTTP GET request to the HTTPS URL with status 308 and Location', async () => {
      const app = createApp();
      const res = await request(app)
        .get('/v1/prices?asset=XLM')
        .set('Host', 'api.smartdrop.example.com');

      expect(res.status).toBe(308);
      expect(res.headers.location).toBe('https://api.smartdrop.example.com/v1/prices?asset=XLM');
    });

    it('rejects state-changing requests over plain HTTP with 403 Forbidden', async () => {
      const app = createApp();
      const res = await request(app)
        .post('/v1/airdrops')
        .set('Host', 'api.smartdrop.example.com')
        .send({ name: 'airdrop' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.body.error.message).toContain('State-changing requests over plain HTTP are prohibited');
    });
  });

  describe('2. Strict-Transport-Security (HSTS)', () => {
    it('sends HSTS header on HTTPS requests with configured values', async () => {
      const app = createApp({
        trustProxy: true,
        httpsConfig: {
          enforce: true,
          hstsMaxAge: 31536000,
          hstsIncludeSubDomains: true,
          hstsPreload: false,
        },
      });

      const res = await request(app)
        .get('/v1/prices')
        .set('X-Forwarded-Proto', 'https');

      expect(res.status).toBe(200);
      expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    });

    it('does NOT send HSTS header on plain HTTP requests', async () => {
      const app = createApp({
        trustProxy: false,
        httpsConfig: { enforce: false }, // Let HTTP pass through to check headers
      });

      const res = await request(app).get('/v1/prices');
      expect(res.status).toBe(200);
      expect(res.headers['strict-transport-security']).toBeUndefined();
    });

    it('only includes preload when strictly opted in', () => {
      const headerWithoutPreload = buildHstsHeader({
        hstsMaxAge: 31536000,
        hstsIncludeSubDomains: true,
        hstsPreload: false,
      });
      expect(headerWithoutPreload).toBe('max-age=31536000; includeSubDomains');

      const headerWithPreload = buildHstsHeader({
        hstsMaxAge: 63072000,
        hstsIncludeSubDomains: true,
        hstsPreload: true,
      });
      expect(headerWithPreload).toBe('max-age=63072000; includeSubDomains; preload');
    });

    it('omits includeSubDomains when configured to false', () => {
      const header = buildHstsHeader({
        hstsMaxAge: 86400,
        hstsIncludeSubDomains: false,
        hstsPreload: false,
      });
      expect(header).toBe('max-age=86400');
    });
  });

  describe('3. Trust Proxy & Secure Request Detection', () => {
    it('ignores forged X-Forwarded-Proto from untrusted client (trust proxy: false)', async () => {
      const app = createApp({ trustProxy: false });

      // Client sends forged X-Forwarded-Proto: https, but trust proxy is disabled
      const res = await request(app)
        .get('/v1/prices')
        .set('X-Forwarded-Proto', 'https')
        .set('Host', 'api.smartdrop.example.com');

      // Must NOT be trusted as HTTPS, so it redirects to HTTPS
      expect(res.status).toBe(308);
      expect(res.headers.location).toBe('https://api.smartdrop.example.com/v1/prices');
    });

    it('honors forwarded protocol when trust proxy allows it', async () => {
      const app = createApp({ trustProxy: true });

      const res = await request(app)
        .get('/v1/prices')
        .set('X-Forwarded-Proto', 'https')
        .set('Host', 'api.smartdrop.example.com');

      // Trusted proxy says it is HTTPS, so it passes through
      expect(res.status).toBe(200);
      expect(res.body.price).toBe(100);
      expect(res.headers['strict-transport-security']).toBeDefined();
    });
  });

  describe('4. Host Header Injection Defense', () => {
    it('does not reflect a hostile Host header in Location', async () => {
      const app = createApp({
        httpsConfig: {
          enforce: true,
          host: 'api.smartdrop.example.com',
          allowedHosts: ['api.smartdrop.example.com'],
          hstsMaxAge: 31536000,
        },
      });

      const res = await request(app)
        .get('/v1/prices')
        .set('Host', 'attacker-controlled.com');

      expect(res.status).toBe(308);
      // Must redirect to configured public host, NEVER attacker-controlled.com
      expect(res.headers.location).toBe('https://api.smartdrop.example.com/v1/prices');
    });

    it('allows a Host header that matches the validated allow list', () => {
      const req = {
        get: (h) => (h.toLowerCase() === 'host' ? 'smartdrop.io' : null),
      };
      const host = resolveRedirectHost(req, {
        host: 'api.smartdrop.example.com',
        allowedHosts: ['api.smartdrop.example.com', 'smartdrop.io'],
      });
      expect(host).toBe('smartdrop.io');
    });
  });

  describe('5. Health Check & Metrics Exemptions', () => {
    it('exempts /health path from HTTPS redirection', async () => {
      const app = createApp();
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('exempts /health/live path from HTTPS redirection', async () => {
      const app = createApp();
      const res = await request(app).get('/health/live');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('live');
    });

    it('exempts /metrics path from HTTPS redirection', async () => {
      const app = createApp();
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.text).toBe('# metrics');
    });
  });

  describe('6. Environment Variable Toggle', () => {
    it('allows disabling enforcement via config (e.g. local development)', async () => {
      const app = createApp({
        httpsConfig: {
          enforce: false,
          hstsMaxAge: 31536000,
        },
      });

      const res = await request(app).get('/v1/prices');
      expect(res.status).toBe(200);
      expect(res.body.price).toBe(100);
    });
  });
});
