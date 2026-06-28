'use strict';

const express = require('express');
const request = require('supertest');
const { createCacheMock } = require('./helpers/cacheMock');

const mockHelper = createCacheMock();
const { reset } = mockHelper;

jest.mock('../src/services/cache', () => mockHelper.cacheMock);
jest.mock('../src/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const mockAxiosPost = jest.fn();
jest.mock('axios', () => ({ post: (...args) => mockAxiosPost(...args) }));

const webhooksRouter = require('../src/routes/webhooks');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', webhooksRouter);
  return app;
}

beforeEach(() => {
  reset();
  mockAxiosPost.mockReset();
});

describe('POST /api/v1/webhooks', () => {
  const app = buildApp();

  test('creates a webhook with valid input', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks')
      .send({
        url: 'https://example.com/hook',
        events: ['pool.assets_locked'],
        secret: 'whsec_user_supplied_secret_long_enough',
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^wh_/);
    expect(res.body.events).toEqual(['pool.assets_locked']);
    expect(res.body.secret).toBe('whsec_user_supplied_secret_long_enough');
    expect(res.body.secret_warning).toMatch(/Store this secret/);
  });

  test('generates a secret when none provided', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks')
      .send({ url: 'https://example.com/hook', events: ['*'] });
    expect(res.status).toBe(201);
    expect(res.body.secret).toMatch(/^whsec_[0-9a-f]+$/);
  });

  test('rejects invalid url', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks')
      .send({ url: 'not-a-url', events: ['*'] });
    expect(res.status).toBe(400);
  });

  test('rejects unknown event types', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks')
      .send({ url: 'https://example.com/hook', events: ['totally.fake'] });
    expect(res.status).toBe(400);
  });

  test('rejects too-short secret', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks')
      .send({ url: 'https://example.com/hook', events: ['*'], secret: 'short' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/v1/webhooks', () => {
  const app = buildApp();

  test('lists registered webhooks without leaking full secrets', async () => {
    await request(app).post('/api/v1/webhooks').send({
      url: 'https://a.com', events: ['*'], secret: 'whsec_aaaaaaaaaaaaaaaa',
    });
    const res = await request(app).get('/api/v1/webhooks');
    expect(res.status).toBe(200);
    expect(res.body.webhooks).toHaveLength(1);
    expect(res.body.webhooks[0].secret_preview).toMatch(/^whsec_/);
    expect(res.body.webhooks[0]).not.toHaveProperty('secret');
  });
});

describe('GET /api/v1/webhooks/:id', () => {
  const app = buildApp();

  test('returns 404 for unknown webhook', async () => {
    const res = await request(app).get('/api/v1/webhooks/wh_nope');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/v1/webhooks/:id', () => {
  const app = buildApp();

  test('deletes a registered webhook', async () => {
    const created = await request(app).post('/api/v1/webhooks').send({
      url: 'https://example.com/hook', events: ['*'], secret: 'whsec_aaaaaaaaaaaaaaaa',
    });
    const del = await request(app).delete(`/api/v1/webhooks/${created.body.id}`);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);

    const list = await request(app).get('/api/v1/webhooks');
    expect(list.body.webhooks).toHaveLength(0);
  });

  test('returns 404 when deleting unknown id', async () => {
    const res = await request(app).delete('/api/v1/webhooks/wh_nope');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/v1/webhooks/:id', () => {
  const app = buildApp();

  test('updates active status', async () => {
    const created = await request(app).post('/api/v1/webhooks').send({
      url: 'https://example.com/hook', events: ['*'], secret: 'whsec_aaaaaaaaaaaaaaaa',
    });
    const res = await request(app)
      .patch(`/api/v1/webhooks/${created.body.id}`)
      .send({ active: false });
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
  });
});

describe('POST /api/v1/webhooks/:id/test', () => {
  const app = buildApp();

  test('sends a test delivery and returns delivery summary', async () => {
    const created = await request(app).post('/api/v1/webhooks').send({
      url: 'https://example.com/hook', events: ['*'], secret: 'whsec_aaaaaaaaaaaaaaaa',
    });
    mockAxiosPost.mockResolvedValueOnce({ status: 200 });

    const res = await request(app).post(`/api/v1/webhooks/${created.body.id}/test`);
    expect(res.status).toBe(202);
    expect(res.body.delivery_id).toMatch(/^dlv_/);
    expect(res.body.status).toBe('success');
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
  });

  test('returns 404 when webhook does not exist', async () => {
    const res = await request(app).post('/api/v1/webhooks/wh_nope/test');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/webhooks/:id/deliveries', () => {
  const app = buildApp();

  test('lists deliveries for a webhook', async () => {
    const created = await request(app).post('/api/v1/webhooks').send({
      url: 'https://example.com/hook', events: ['*'], secret: 'whsec_aaaaaaaaaaaaaaaa',
    });
    mockAxiosPost.mockResolvedValue({ status: 200 });
    await request(app).post(`/api/v1/webhooks/${created.body.id}/test`);

    const res = await request(app).get(`/api/v1/webhooks/${created.body.id}/deliveries`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.deliveries)).toBe(true);
    expect(res.body.deliveries.length).toBeGreaterThan(0);
  });
});
