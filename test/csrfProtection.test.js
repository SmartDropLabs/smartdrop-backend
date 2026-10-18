'use strict';

const express = require('express');
const request = require('supertest');
const {
  createCsrfProtectionMiddleware,
  csrfTokenHandler,
  generateCsrfToken,
  verifyCsrfToken,
  hasMethodOverride,
} = require('../src/middleware/csrf');
const { errorHandler } = require('../src/middleware/errorHandler');

describe('Issue #465: Global CSRF Protection', () => {
  const allowedOrigins = ['http://localhost:3000', 'https://smartdrop.io'];
  const testSecret = 'test-csrf-secret-key-32-bytes!';

  function createApp(options = {}) {
    const app = express();
    app.use(express.json());

    // Middleware to simulate session attachment from cookie if present
    app.use((req, res, next) => {
      const rawCookie = req.headers.cookie || '';
      const match = rawCookie.match(/(?:^|;\s*)session_id=([^;]+)/);
      if (match) {
        req.session = { id: decodeURIComponent(match[1]) };
      }
      next();
    });

    const csrf = createCsrfProtectionMiddleware({
      allowedOrigins: options.allowedOrigins || allowedOrigins,
      exemptPaths: options.exemptPaths || ['/webhooks/signed-callback'],
      secret: testSecret,
    });

    app.get('/csrf-token', csrfTokenHandler);
    app.use(csrf);

    // Routes
    app.get('/api/items', (req, res) => res.status(200).json({ items: [] }));
    app.post('/api/items', (req, res) => res.status(201).json({ created: true }));
    app.put('/api/items/:id', (req, res) => res.status(200).json({ updated: true }));
    app.delete('/api/items/:id', (req, res) => res.status(200).json({ deleted: true }));

    // Declared webhook route (simulating webhook with signature or exempt path)
    app.post('/webhooks/signed-callback', (req, res) => res.status(200).json({ webhook: true }));

    // Undeclared new route
    app.post('/api/new-undeclared-feature', (req, res) => res.status(201).json({ success: true }));

    app.use(errorHandler);
    return app;
  }

  describe('1. State-Changing Route Protection', () => {
    it('rejects a state-changing POST request without a CSRF token with 403 Forbidden', async () => {
      const app = createApp();
      const res = await request(app)
        .post('/api/items')
        .set('Origin', 'http://localhost:3000')
        .send({ name: 'Widget' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.body.error.message).toContain('Missing CSRF token');
    });

    it('allows a state-changing request with a valid token and allowed Origin', async () => {
      const app = createApp();
      const sessionId = 'session-alice-123';
      const token = generateCsrfToken(sessionId, testSecret);

      const res = await request(app)
        .post('/api/items')
        .set('Cookie', `session_id=${sessionId}`)
        .set('Origin', 'http://localhost:3000')
        .set('X-CSRF-Token', token)
        .send({ name: 'Widget' });

      expect(res.status).toBe(201);
      expect(res.body.created).toBe(true);
    });

    it('protects an undeclared new route by default', async () => {
      const app = createApp();
      const res = await request(app)
        .post('/api/new-undeclared-feature')
        .set('Origin', 'http://localhost:3000')
        .send({ action: 'doSomething' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('2. Session Binding & Tamper Resistance', () => {
    it('rejects a token issued for another session', async () => {
      const app = createApp();
      const bobSessionId = 'session-bob-456';
      const bobsToken = generateCsrfToken(bobSessionId, testSecret);

      // Alice tries to use Bob's token
      const aliceSessionId = 'session-alice-123';
      const res = await request(app)
        .post('/api/items')
        .set('Cookie', `session_id=${aliceSessionId}`)
        .set('Origin', 'http://localhost:3000')
        .set('X-CSRF-Token', bobsToken)
        .send({ name: 'Widget' });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('Invalid CSRF token');
    });

    it('rejects a tampered or truncated token', async () => {
      const app = createApp();
      const sessionId = 'session-alice-123';
      const validToken = generateCsrfToken(sessionId, testSecret);
      const tamperedToken = validToken.slice(0, -6) + 'abcdef';

      const res = await request(app)
        .post('/api/items')
        .set('Cookie', `session_id=${sessionId}`)
        .set('Origin', 'http://localhost:3000')
        .set('X-CSRF-Token', tamperedToken)
        .send({ name: 'Widget' });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('Invalid CSRF token');
    });

    it('never accepts CSRF token from the URL query string', async () => {
      const app = createApp();
      const sessionId = 'session-alice-123';
      const token = generateCsrfToken(sessionId, testSecret);

      const res = await request(app)
        .post(`/api/items?csrf_token=${token}&_csrf=${token}`)
        .set('Cookie', `session_id=${sessionId}`)
        .set('Origin', 'http://localhost:3000')
        .send({ name: 'Widget' });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('Missing CSRF token');
    });
  });

  describe('3. Safe Methods Exemption', () => {
    it('exempts safe methods (GET, HEAD, OPTIONS) from requiring a token', async () => {
      const app = createApp();
      const res = await request(app).get('/api/items');
      expect(res.status).toBe(200);
      expect(res.body.items).toBeDefined();

      const headRes = await request(app).head('/api/items');
      expect(headRes.status).toBe(200);
    });
  });

  describe('4. Origin and Referer Policy', () => {
    it('rejects a state-changing request from a mismatched Origin even with a token', async () => {
      const app = createApp();
      const sessionId = 'session-123';
      const token = generateCsrfToken(sessionId, testSecret);

      const res = await request(app)
        .post('/api/items')
        .set('Cookie', `session_id=${sessionId}`)
        .set('Origin', 'http://attacker-site.evil.com')
        .set('X-CSRF-Token', token)
        .send({ name: 'Widget' });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('Cross-origin request rejected');
    });

    it('accepts an allowed Origin', async () => {
      const app = createApp();
      const sessionId = 'session-123';
      const token = generateCsrfToken(sessionId, testSecret);

      const res = await request(app)
        .post('/api/items')
        .set('Cookie', `session_id=${sessionId}`)
        .set('Origin', 'https://smartdrop.io')
        .set('X-CSRF-Token', token)
        .send({ name: 'Widget' });

      expect(res.status).toBe(201);
    });

    it('falls back to Referer when Origin is absent', async () => {
      const app = createApp();
      const sessionId = 'session-123';
      const token = generateCsrfToken(sessionId, testSecret);

      const res = await request(app)
        .post('/api/items')
        .set('Cookie', `session_id=${sessionId}`)
        .set('Referer', 'https://smartdrop.io/dashboard')
        .set('X-CSRF-Token', token)
        .send({ name: 'Widget' });

      expect(res.status).toBe(201);
    });
  });

  describe('5. Header Authentication & Webhook Exemptions', () => {
    it('exempts requests authenticated by Authorization header', async () => {
      const app = createApp();
      const res = await request(app)
        .post('/api/items')
        .set('Authorization', 'Bearer valid-api-key')
        .send({ name: 'API Widget' });

      expect(res.status).toBe(201);
      expect(res.body.created).toBe(true);
    });

    it('exempts declared webhook route verifying signatures', async () => {
      const app = createApp();
      const res = await request(app)
        .post('/webhooks/signed-callback')
        .send({ event: 'delivery.success' });

      expect(res.status).toBe(200);
      expect(res.body.webhook).toBe(true);
    });
  });

  describe('6. Method Override Rejection', () => {
    it('rejects X-HTTP-Method-Override header attempts to disguise requests', async () => {
      const app = createApp();
      const res = await request(app)
        .get('/api/items')
        .set('X-HTTP-Method-Override', 'POST');

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('Method override is prohibited');
    });

    it('rejects ?_method=POST query parameter override', async () => {
      const app = createApp();
      const res = await request(app).get('/api/items?_method=POST');

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('Method override is prohibited');
    });
  });

  describe('7. Token Endpoint and Constant-Time Comparison', () => {
    it('provides a token endpoint returning the token in response body', async () => {
      const app = createApp();
      const sessionId = 'user-sess-100';

      const res = await request(app)
        .get('/csrf-token')
        .set('Cookie', `session_id=${sessionId}`);

      expect(res.status).toBe(200);
      expect(res.body.csrf_token).toBeDefined();
      expect(typeof res.body.csrf_token).toBe('string');

      // Validates successfully for that session
      expect(verifyCsrfToken(res.body.csrf_token, sessionId, testSecret)).toBe(true);
    });

    it('performs timing-safe comparison on verifyCsrfToken', () => {
      const sessionId = 'session-abc';
      const token = generateCsrfToken(sessionId, testSecret);

      expect(verifyCsrfToken(token, sessionId, testSecret)).toBe(true);
      expect(verifyCsrfToken(token, 'different-session', testSecret)).toBe(false);
      expect(verifyCsrfToken('', sessionId, testSecret)).toBe(false);
      expect(verifyCsrfToken('invalid.format.extra', sessionId, testSecret)).toBe(false);
    });
  });
});
