'use strict';

/**
 * #499 — Output encoding, response security headers, and injection prevention test suite.
 */

const express = require('express');
const request = require('supertest');
const { escapeHtml, renderSafeErrorHtml } = require('../src/utils/htmlEscape');
const {
  buildSafeContentDisposition,
  setSafeDownloadHeaders,
} = require('../src/utils/contentDisposition');
const {
  headerSecurityMiddleware,
  sanitizeHeaderString,
} = require('../src/middleware/headerSecurity');
const { redactInfo } = require('../src/services/logRedaction');

describe('Output Encoding & Response Security (#499)', () => {
  describe('1. JSON API output encoding & round trip', () => {
    let app;

    beforeAll(() => {
      app = express();
      app.use(headerSecurityMiddleware);
      app.use(express.json());

      // Mock JSON API route simulating create & retrieve
      const store = new Map();

      app.post('/api/test-echo', (req, res) => {
        const id = 'item_1';
        store.set(id, req.body);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.status(201).json({ id, ...req.body });
      });

      app.get('/api/test-echo/:id', (req, res) => {
        const data = store.get(req.params.id);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.json({ id: req.params.id, ...data });
      });
    });

    test('script tags round trip through JSON API unchanged without being corrupted or HTML-escaped in stored data', async () => {
      const scriptPayload = '<script>alert(1)</script>';

      const postRes = await request(app)
        .post('/api/test-echo')
        .send({ payload: scriptPayload })
        .expect(201);

      // Asserts Content-Type is application/json and nosniff header is present
      expect(postRes.headers['content-type']).toMatch(/application\/json/);
      expect(postRes.headers['x-content-type-options']).toBe('nosniff');
      expect(postRes.body.payload).toBe(scriptPayload);

      // Read back: unchanged, no double-encoding or stripping
      const getRes = await request(app)
        .get('/api/test-echo/item_1')
        .expect(200);

      expect(getRes.headers['content-type']).toMatch(/application\/json/);
      expect(getRes.headers['x-content-type-options']).toBe('nosniff');
      expect(getRes.body.payload).toBe(scriptPayload);
    });

    test('legitimate special characters (apostrophes, quotes, ampersands, URLs, Stellar keys) are unaltered', async () => {
      const complexData = {
        name: "O'Connor & Sons",
        quote: 'He said "Hello world"',
        url: 'https://horizon.stellar.org/ledgers?cursor=now&order=desc',
        stellarAddress: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        signature: 'sig_a+b/c=123$',
      };

      const res = await request(app)
        .post('/api/test-echo')
        .send(complexData)
        .expect(201);

      expect(res.body.name).toBe("O'Connor & Sons");
      expect(res.body.quote).toBe('He said "Hello world"');
      expect(res.body.url).toBe('https://horizon.stellar.org/ledgers?cursor=now&order=desc');
      expect(res.body.stellarAddress).toBe('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');
      expect(res.body.signature).toBe('sig_a+b/c=123$');
    });
  });

  describe('2. HTML context escaping', () => {
    test('escapeHtml properly escapes XSS characters', () => {
      expect(escapeHtml('<script>alert("xss")</script>'))
        .toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
      expect(escapeHtml("Tom & Jerry's"))
        .toBe('Tom &amp; Jerry&#39;s');
      expect(escapeHtml(null)).toBe('');
      expect(escapeHtml(undefined)).toBe('');
    });

    test('renderSafeErrorHtml escapes user values in HTML context and does not echo raw input', () => {
      const maliciousInput = '<img src=x onerror=alert(1)>';
      const html = renderSafeErrorHtml({
        title: 'Error with ' + maliciousInput,
        message: 'Failed to process ' + maliciousInput,
        statusCode: 400,
      });

      expect(html).not.toContain('<img src=x onerror=alert(1)>');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(html).toContain('<!DOCTYPE html>');
    });
  });

  describe('3. Header injection & CRLF prevention', () => {
    let app;

    beforeAll(() => {
      app = express();
      app.use(headerSecurityMiddleware);

      app.get('/test-header', (req, res) => {
        const customVal = req.query.val;
        res.setHeader('X-Custom-Header', customVal);
        res.send('ok');
      });
    });

    test('rejects CRLF in response header values to prevent response splitting', async () => {
      expect(() => {
        sanitizeHeaderString('valid-value');
      }).not.toThrow();

      expect(() => {
        sanitizeHeaderString('malicious\r\nInjected: true');
      }).toThrow(/header injection rejected/i);

      expect(() => {
        sanitizeHeaderString('value\nwith-newline');
      }).toThrow(/header injection rejected/i);

      expect(() => {
        sanitizeHeaderString('value\rwith-cr');
      }).toThrow(/header injection rejected/i);
    });

    test('request with CRLF in header value fails with 400 or is caught by middleware', async () => {
      const res = await request(app)
        .get('/test-header?val=clean-header-value')
        .expect(200);
      expect(res.headers['x-custom-header']).toBe('clean-header-value');

      await request(app)
        .get('/test-header?val=evil%0D%0ASet-Cookie:%20admin=true')
        .expect(500); // Caught and rejected by header security
    });
  });

  describe('4. Safe file downloads & Content-Disposition', () => {
    test('buildSafeContentDisposition strips path traversal', () => {
      const header = buildSafeContentDisposition('../../etc/passwd.csv');
      expect(header).not.toContain('..');
      expect(header).not.toContain('/');
      expect(header).toContain('filename="passwd.csv"');
    });

    test('buildSafeContentDisposition strips CRLF characters', () => {
      const header = buildSafeContentDisposition('report\r\nInjected: evil.csv');
      expect(header).not.toContain('\r');
      expect(header).not.toContain('\n');
      expect(header).toContain('filename="reportInjected__evil.csv"');
    });

    test('buildSafeContentDisposition handles empty and non-string inputs with default fallback', () => {
      expect(buildSafeContentDisposition('')).toBe('attachment; filename="download"');
      expect(buildSafeContentDisposition(null)).toBe('attachment; filename="download"');
    });

    test('setSafeDownloadHeaders applies safe download and nosniff headers', () => {
      const headers = {};
      const mockRes = {
        setHeader: (k, v) => {
          headers[k.toLowerCase()] = v;
        },
      };

      setSafeDownloadHeaders(mockRes, 'airdrop_recipients.csv', 'text/csv');

      expect(headers['content-type']).toBe('text/csv');
      expect(headers['content-disposition']).toContain('filename="airdrop_recipients.csv"');
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['x-download-options']).toBe('noopen');
    });
  });

  describe('5. Log injection prevention (CRLF escaping in logger)', () => {
    test('escapes CR and LF characters in logged strings', () => {
      const input = {
        user_input: 'normal text\r\n[CRITICAL] 2026-10-18 Forged log line: user granted admin',
        nested: {
          param: 'line1\nline2',
        },
      };

      const redacted = redactInfo(input);

      expect(redacted.user_input).not.toContain('\r');
      expect(redacted.user_input).not.toContain('\n');
      expect(redacted.user_input).toContain('\\r\\n[CRITICAL]');
      expect(redacted.nested.param).toBe('line1\\nline2');
    });
  });
});
