'use strict';

const express = require('express');
const request = require('supertest');

const mockGetAirdropStatus = jest.fn();
const mockGetAirdropRecipients = jest.fn();
const mockGetRecipientClaims = jest.fn();
const mockGetStats = jest.fn();

jest.mock('../src/indexer/eventStore', () => ({
  getAirdropStatus: mockGetAirdropStatus,
  getAirdropRecipients: mockGetAirdropRecipients,
  getRecipientClaims: mockGetRecipientClaims,
  getStats: mockGetStats,
}));

jest.mock('../src/indexer/runtime', () => ({
  getStatus: jest.fn(() => ({
    enabled: true,
    configured: true,
    running: true,
    contract_id: 'CCONTRACT',
    poll_interval_ms: 5000,
    poll_limit: 100,
    last_run: '2026-06-25T00:00:00.000Z',
    last_error: null,
  })),
}));

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const indexerRouter = require('../src/routes/indexer');

function buildApp() {
  const app = express();
  app.use('/api/v1', indexerRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('indexer routes', () => {
  test('returns indexed airdrop status', async () => {
    mockGetAirdropStatus.mockResolvedValue({
      airdrop_id: 'drop-1',
      status: 'created',
      recipients_count: 2,
    });

    const res = await request(buildApp()).get('/api/v1/airdrops/drop-1/status');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ airdrop_id: 'drop-1', status: 'created' });
  });

  test('returns 404 for unknown airdrop status', async () => {
    mockGetAirdropStatus.mockResolvedValue(null);

    const res = await request(buildApp()).get('/api/v1/airdrops/missing/status');

    expect(res.status).toBe(404);
  });

  test('returns indexed recipients', async () => {
    mockGetAirdropRecipients.mockResolvedValue([{ recipient: 'GRECIPIENT', status: 'claimed' }]);

    const res = await request(buildApp()).get('/api/v1/airdrops/drop-1/recipients');

    expect(res.status).toBe(200);
    expect(res.body.recipients).toHaveLength(1);
  });

  test('returns recipient claims', async () => {
    mockGetRecipientClaims.mockResolvedValue([{ airdrop_id: 'drop-1', amount: '25' }]);

    const res = await request(buildApp()).get('/api/v1/recipients/GRECIPIENT12345/claims');

    expect(res.status).toBe(200);
    expect(res.body.claims).toEqual([{ airdrop_id: 'drop-1', amount: '25' }]);
  });

  test('returns indexer status with ledger and event counts', async () => {
    mockGetStats.mockResolvedValue({ last_ledger: 42, events_count: 7 });

    const res = await request(buildApp()).get('/api/v1/indexer/status');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      configured: true,
      last_ledger: 42,
      events_count: 7,
    });
  });
});
