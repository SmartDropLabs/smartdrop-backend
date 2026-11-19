'use strict';

const express = require('express');
const helmet = require('helmet');
const request = require('supertest');
const {
  API_CSP_DIRECTIVES,
  DOCS_CSP_DIRECTIVES,
  docsCspMiddleware,
} = require('../src/middleware/csp');

function buildApiApp() {
  const app = express();
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: API_CSP_DIRECTIVES,
    },
  }));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  return app;
}

describe('Content-Security-Policy', () => {
  test('API responses deny all browser resources by default', async () => {
    const res = await request(buildApiApp()).get('/health');

    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  test('docs responses allow the inline assets Swagger UI requires', async () => {
    const app = express();
    app.use(helmet());
    app.use('/api-docs', docsCspMiddleware);
    app.get('/api-docs/', (_req, res) => res.type('html').send('<html></html>'));

    const res = await request(app).get('/api-docs/');

    expect(res.headers['content-security-policy']).toBe(DOCS_CSP_DIRECTIVES);
    expect(res.headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline'");
  });
});
