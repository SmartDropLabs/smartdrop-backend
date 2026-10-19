'use strict';

const express = require('express');
const request = require('supertest');
const compression = require('compression');

function buildApp() {
  const app = express();
  app.use(compression());
  app.get('/large', (_req, res) => {
    // Generate a payload larger than compression threshold (default 1024 bytes)
    const largeData = { data: 'x'.repeat(2048) };
    res.json(largeData);
  });
  return app;
}

describe('Response compression middleware', () => {
  const app = buildApp();

  test('compresses large responses when Accept-Encoding: gzip is sent', async () => {
    const res = await request(app)
      .get('/large')
      .set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  test('does not compress response when Accept-Encoding does not include gzip', async () => {
    const res = await request(app)
      .get('/large')
      .set('Accept-Encoding', 'identity');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});
