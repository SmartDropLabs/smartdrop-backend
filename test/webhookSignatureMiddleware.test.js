'use strict';

const crypto = require('crypto');

jest.mock('../src/config', () => ({
  webhooks: { signatureSecret: 'test-webhook-secret' },
}));

const express = require('express');
const request = require('supertest');
const { webhookSignatureMiddleware } = require('../src/middleware/webhookSignature');

const SECRET = 'test-webhook-secret';

function buildApp() {
  const app = express();
  app.use(express.text({ type: '*/*' }));
  app.use((req, _res, next) => {
    req.rawBody = Buffer.from(req.body);
    next();
  });
  app.post('/incoming', webhookSignatureMiddleware, (_req, res) => res.sendStatus(204));
  return app;
}

function sign(timestamp, body) {
  return `sha256=${crypto
    .createHmac('sha256', SECRET)
    .update(`${timestamp}.`)
    .update(body)
    .digest('hex')}`;
}

describe('incoming webhook signature timestamp verification', () => {
  const app = buildApp();
  const body = 'payload';

  test('accepts a current timestamp bound to the signature', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const res = await request(app)
      .post('/incoming')
      .set('X-Webhook-Timestamp', timestamp)
      .set('X-Webhook-Signature', sign(timestamp, body))
      .send(body);

    expect(res.status).toBe(204);
  });

  test('rejects a missing timestamp', async () => {
    const res = await request(app)
      .post('/incoming')
      .set('X-Webhook-Signature', sign(String(Math.floor(Date.now() / 1000)), body))
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('WEBHOOK_TIMESTAMP_MISSING');
  });

  test('rejects stale timestamps even when the signature matches', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000) - 301);
    const res = await request(app)
      .post('/incoming')
      .set('X-Webhook-Timestamp', timestamp)
      .set('X-Webhook-Signature', sign(timestamp, body))
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('WEBHOOK_SIGNATURE_EXPIRED');
  });

  test('rejects a timestamp changed after signing', async () => {
    const signedTimestamp = String(Math.floor(Date.now() / 1000));
    const replacedTimestamp = String(Number(signedTimestamp) + 1);
    const res = await request(app)
      .post('/incoming')
      .set('X-Webhook-Timestamp', replacedTimestamp)
      .set('X-Webhook-Signature', sign(signedTimestamp, body))
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });
});
