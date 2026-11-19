'use strict';

const express = require('express');
const request = require('supertest');
const requestValidation = require('../src/middleware/requestValidation');
const { errorHandler } = require('../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(requestValidation);
  app.post('/api/v1/airdrops/:id/recipients', (_req, res) => res.status(204).end());
  app.post('/api/v1/airdrops', (_req, res) => res.status(204).end());
  app.use(errorHandler);
  return app;
}

describe('requestValidation', () => {
  test('accepts multipart uploads on the recipient route', async () => {
    const res = await request(buildApp())
      .post('/api/v1/airdrops/drop_abc/recipients')
      .attach('file', Buffer.from('address,amount\n'), 'recipients.csv');

    expect(res.status).toBe(204);
  });

  test('rejects multipart bodies on JSON-only routes', async () => {
    const res = await request(buildApp())
      .post('/api/v1/airdrops')
      .attach('file', Buffer.from('address,amount\n'), 'recipients.csv');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('allows bodyless requests without a content type', async () => {
    const res = await request(buildApp()).post('/api/v1/airdrops');

    expect(res.status).toBe(204);
  });
});
