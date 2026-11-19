'use strict';

const express = require('express');
const request = require('supertest');
const { z } = require('zod');

const requestValidationMiddleware = require('../src/middleware/requestValidation');
const { validate } = require('../src/middleware/validate');
const { errorHandler } = require('../src/middleware/errorHandler');
const { escapeHtml } = require('../src/utils/sanitizeHtml');

jest.mock('../src/services/errorTracker', () => ({
  captureException: jest.fn(),
}));

function buildApp(options = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(requestValidationMiddleware);

  const sampleSchema = z.object({
    name: z.string().min(1).max(50),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
  });

  app.post('/test/items', validate(sampleSchema), (req, res) => {
    res.json({
      received: req.validated.body,
      storedAsPlainText: req.validated.body.name,
      htmlEscapedOutput: escapeHtml(req.validated.body.name),
    });
  });

  app.get('/test/items/:id', (req, res) => {
    res.json({ id: req.params.id, query: req.query });
  });

  app.use(errorHandler);
  return app;
}

describe('Issue #459: Input Sanitization and Security Validation', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  describe('Unknown fields validation', () => {
    test('rejects unknown fields with 400 and a safe message', async () => {
      const res = await request(app)
        .post('/test/items')
        .send({
          name: 'Valid Name',
          malicious_extra_field: 'hacker_payload',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toBe('Validation failed');
      expect(JSON.stringify(res.body.error.details)).toContain('Unrecognized key(s)');
    });
  });

  describe('Malformed and oversized input validation', () => {
    test('rejects input containing null bytes with 400', async () => {
      const res = await request(app)
        .post('/test/items')
        .send({
          name: 'Exploit\0Name',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('control characters or null bytes');
    });

    test('rejects input containing ASCII control characters with 400', async () => {
      const res = await request(app)
        .post('/test/items')
        .send({
          name: 'Exploit\x08Name',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('control characters or null bytes');
    });

    test('rejects oversized Content-Length header with 413', async () => {
      const res = await request(app)
        .post('/test/items')
        .set('Content-Type', 'application/json')
        .set('Content-Length', String(20 * 1024 * 1024))
        .send(JSON.stringify({ name: 'test' }));

      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });

    test('rejects invalid Content-Type on POST with 400', async () => {
      const res = await request(app)
        .post('/test/items')
        .set('Content-Type', 'text/plain')
        .send('raw text data');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('Unsupported Content-Type');
    });
  });

  describe('NoSQL injection and prototype pollution guards', () => {
    test('rejects NoSQL-style $gt operator objects with 400', async () => {
      const res = await request(app)
        .post('/test/items')
        .send({
          $gt: { name: '' },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('Invalid operator');
    });

    test('rejects prototype pollution attempts with 400', async () => {
      const res = await request(app)
        .post('/test/items')
        .send({
          __proto__: { isAdmin: true },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Path traversal guard', () => {
    test('rejects directory traversal in route parameters with 400', async () => {
      const res = await request(app)
        .get('/test/items/..%2f..%2fetc%2fpasswd');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('Path traversal');
    });

    test('rejects directory traversal in query string with 400', async () => {
      const res = await request(app)
        .get('/test/items/123?file=../../secret.txt');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('Path traversal');
    });
  });

  describe('Preservation of legitimate data and SQL injection handling', () => {
    test('preserves legitimate names with apostrophes and quotes without mutation', async () => {
      const legitimateName = "O'Connor d'Artagnan";
      const res = await request(app)
        .post('/test/items')
        .send({ name: legitimateName });

      expect(res.status).toBe(200);
      expect(res.body.received.name).toBe(legitimateName);
      expect(res.body.storedAsPlainText).toBe(legitimateName);
    });

    test('stores SQL injection payload as harmless plain text without altering or executing it', async () => {
      const sqlInjectionPayload = "admin' OR 1=1 --";
      const res = await request(app)
        .post('/test/items')
        .send({ name: sqlInjectionPayload });

      expect(res.status).toBe(200);
      expect(res.body.received.name).toBe(sqlInjectionPayload);
      expect(res.body.storedAsPlainText).toBe(sqlInjectionPayload);
    });

    test('preserves legitimate special characters: Stellar addresses, base64, and passwords', async () => {
      const stellarAddr = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
      const password = 'P@ssw0rd!#%^&*()_+-=[]{}|;:,.<>?';
      const base64Sig = 'whsec_a1b2c3d4e5f6g7h8+/=';

      const res = await request(app)
        .post('/test/items')
        .send({
          name: stellarAddr.slice(0, 50),
          description: password,
          tags: [base64Sig],
        });

      expect(res.status).toBe(200);
      expect(res.body.received.name).toBe(stellarAddr.slice(0, 50));
      expect(res.body.received.description).toBe(password);
      expect(res.body.received.tags[0]).toBe(base64Sig);
    });

    test('escapes HTML safely at output boundary without mutating stored plain text', async () => {
      const xssPayload = '<script>alert("XSS")</script>';
      const res = await request(app)
        .post('/test/items')
        .send({ name: xssPayload });

      expect(res.status).toBe(200);
      expect(res.body.storedAsPlainText).toBe(xssPayload);
      expect(res.body.htmlEscapedOutput).toBe('&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;');
    });
  });
});
