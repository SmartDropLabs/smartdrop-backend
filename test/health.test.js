'use strict';

const request = require('supertest');

jest.mock('../src/services/cache', () => ({
  isConnected: jest.fn(() => false),
  disconnect: jest.fn(),
}));

jest.mock('../src/services/priceOracle', () => ({
  getCircuitStates: jest.fn(() => ({
    coingecko: 'closed',
    coinmarketcap: 'open',
    stellar_dex: 'half-open',
  })),
  refreshAllCachedPrices: jest.fn(),
}));

jest.mock('../src/jobs/priceRefresh', () => ({
  start: jest.fn(),
  stop: jest.fn(),
}));

jest.mock('../src/jobs/webhookRetryWorker', () => ({
  start: jest.fn(),
  stop: jest.fn(),
}));

jest.mock('../src/ws/priceWebSocket', () => ({
  attach: jest.fn(),
}));

describe('health endpoint', () => {
  test('exposes price source circuit states', async () => {
    jest.resetModules();
    const { app } = require('../src/index');

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.circuits).toEqual({
      coingecko: 'closed',
      coinmarketcap: 'open',
      stellar_dex: 'half-open',
    });
  });
});
