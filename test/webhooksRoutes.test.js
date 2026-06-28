'use strict';

const express = require('express');
const request = require('supertest');

const mockCreateEndpoint = jest.fn();
const mockListEndpoints = jest.fn();
const mockRemoveEndpoint = jest.fn();
const mockGetEndpoint = jest.fn();
const mockSendTestPing = jest.fn();
const mockListDeliveries = jest.fn();

jest.mock('../src/services/webhooks', () => ({
  VALID_EVENTS: [
    'airdrop.created',
    'airdrop.executing',
    'airdrop.completed',
    'airdrop.failed',
    'recipient.claimed',
  ],
  createEndpoint: mockCreateEndpoint,
  listEndpoints: mockListEndpoints,
  removeEndpoint: mockRemoveEndpoint,
  getEndpoint: mockGetEndpoint,
  sendTestPing: mockSendTestPing,
  listDeliveries: mockListDeliveries,
}));

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const webhooksRouter = require('../src/routes/webhooks');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', webhooksRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('webhook routes', () => {
  test('creates webhook endpoint', async () => {
    mockCreateEndpoint.mockResolvedValue({
      id: 'wh_123',
      url: 'https://example.com/hook',
      events: ['airdrop.completed'],
      secret_preview: 'whse...cret',
    });

    const res = await request(buildApp())
      .post('/api/v1/webhooks')
      .send({
        url: 'https://example.com/hook',
        events: ['airdrop.completed'],
        secret: 'whsec_testsecret',
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'wh_123', secret_preview: 'whse...cret' });
    expect(mockCreateEndpoint).toHaveBeenCalledWith({
      url: 'https://example.com/hook',
      events: ['airdrop.completed'],
      secret: 'whsec_testsecret',
    });
  });

  test('rejects invalid events', async () => {
    const res = await request(buildApp())
      .post('/api/v1/webhooks')
      .send({
        url: 'https://example.com/hook',
        events: ['not.real'],
        secret: 'whsec_testsecret',
      });

    expect(res.status).toBe(400);
  });

  test('lists endpoints', async () => {
    mockListEndpoints.mockResolvedValue([{ id: 'wh_123' }]);

    const res = await request(buildApp()).get('/api/v1/webhooks');

    expect(res.status).toBe(200);
    expect(res.body.webhooks).toEqual([{ id: 'wh_123' }]);
  });

  test('deletes endpoint', async () => {
    mockRemoveEndpoint.mockResolvedValue({ id: 'wh_123' });

    const res = await request(buildApp()).delete('/api/v1/webhooks/wh_123');

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  test('queues test ping delivery', async () => {
    mockSendTestPing.mockResolvedValue({ id: 'dlv_123', status: 'pending' });

    const res = await request(buildApp()).post('/api/v1/webhooks/wh_123/test');

    expect(res.status).toBe(202);
    expect(res.body.delivery).toMatchObject({ id: 'dlv_123' });
  });

  test('lists delivery attempts', async () => {
    mockGetEndpoint.mockResolvedValue({ id: 'wh_123', active: true });
    mockListDeliveries.mockResolvedValue([{ id: 'dlv_123', attempt_count: 1 }]);

    const res = await request(buildApp()).get('/api/v1/webhooks/wh_123/deliveries');

    expect(res.status).toBe(200);
    expect(res.body.deliveries).toEqual([{ id: 'dlv_123', attempt_count: 1 }]);
  });
});
