'use strict';

const express = require('express');
const request = require('supertest');

const mockListAlerts = jest.fn();

jest.mock('../src/services/alerts', () => ({
  list: mockListAlerts,
}));

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const alertsRouter = require('../src/routes/alerts');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', alertsRouter);
  return app;
}

function alert(id) {
  return {
    id,
    asset: 'XLM',
    type: 'below',
    threshold_usd: 0.09,
  };
}

describe('alert routes pagination', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    mockListAlerts.mockReset();
  });

  test('GET /alerts returns the standard list response envelope', async () => {
    mockListAlerts.mockResolvedValueOnce([alert('alrt_1'), alert('alrt_2'), alert('alrt_3')]);

    const res = await request(app)
      .get('/api/v1/alerts')
      .query({ page: '2', limit: '2' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [alert('alrt_3')],
      pagination: {
        page: 2,
        limit: 2,
        total: 3,
        total_pages: 2,
        has_next: false,
        has_prev: true,
      },
    });
  });

  test('GET /alerts clamps invalid pagination params without rejecting', async () => {
    mockListAlerts.mockResolvedValueOnce([alert('alrt_1'), alert('alrt_2')]);

    const res = await request(app)
      .get('/api/v1/alerts')
      .query({ page: '0', limit: '9999' });

    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({
      page: 1,
      limit: 100,
      total: 2,
      total_pages: 1,
      has_next: false,
      has_prev: false,
    });
    expect(res.body.data).toHaveLength(2);
  });
});
