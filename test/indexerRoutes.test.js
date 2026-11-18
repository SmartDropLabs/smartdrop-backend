'use strict';

const express = require('express');
const request = require('supertest');
const { createCacheMock } = require('./helpers/cacheMock');

const mockHelper = createCacheMock();
const { reset } = mockHelper;

const mockGetAirdropStatus = jest.fn();
const mockGetAirdropRecipients = jest.fn();
const mockGetRecipientClaims = jest.fn();
const mockGetStats = jest.fn();

jest.mock('../src/services/cache', () => mockHelper.cacheMock);
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
const { errorHandler } = require('../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use('/api/v1', indexerRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  reset();
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

  test('returns indexed recipients in the canonical pagination envelope (#131)', async () => {
    mockGetAirdropRecipients.mockResolvedValue([{ recipient: 'GRECIPIENT', status: 'claimed' }]);

    const res = await request(buildApp()).get('/api/v1/airdrops/drop-1/onchain-recipients');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 20, total: 1 });
  });

  test('returns recipient claims in the canonical pagination envelope (#131)', async () => {
    mockGetRecipientClaims.mockResolvedValue([{ airdrop_id: 'drop-1', amount: '25' }]);

    const res = await request(buildApp()).get('/api/v1/recipients/GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H/claims');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ airdrop_id: 'drop-1', amount: '25' }]);
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 20, total: 1 });
  });

  test('paginates recipient claims with page/limit query params (#131)', async () => {
    mockGetRecipientClaims.mockResolvedValue(
      Array.from({ length: 3 }, (_, i) => ({ airdrop_id: `drop-${i}`, amount: '1' })),
    );

    const res = await request(buildApp()).get(
      '/api/v1/recipients/GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H/claims?page=1&limit=2',
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination).toMatchObject({
      page: 1,
      limit: 2,
      total: 3,
      total_pages: 2,
      has_next: true,
      has_prev: false,
    });
  });

  // #602 — the indexer param schemas were not exported, so validate() got
  // `undefined` and these routes threw before reaching the handler.
  test('validates the airdrop id instead of crashing (#602)', async () => {
    const res = await request(buildApp()).get('/api/v1/airdrops/bad%20id!/status');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockGetAirdropStatus).not.toHaveBeenCalled();
  });

  // #603 — only a Stellar account (G…) or contract (C…) strkey reaches the store.
  test.each([
    ['GRECIPIENT12345'],
    ['SBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H'],
    ['gbrpyhil2ci3fnq4bxlfmndlfjunpu2hy3zmfshonuceoasw7qc7ox2h'],
    ['GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX20'],
  ])('rejects recipient address %p (#603)', async (address) => {
    const res = await request(buildApp()).get(`/api/v1/recipients/${address}/claims`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockGetRecipientClaims).not.toHaveBeenCalled();
  });

  test('passes the validated contract address to the store (#603)', async () => {
    mockGetRecipientClaims.mockResolvedValue([]);
    const contract = 'CBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

    const res = await request(buildApp()).get(`/api/v1/recipients/${contract}/claims`);

    expect(res.status).toBe(200);
    expect(mockGetRecipientClaims).toHaveBeenCalledWith(contract);
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

  test('rate limits indexer status to 1 request per second per IP', async () => {
    mockGetStats.mockResolvedValue({ last_ledger: 42, events_count: 7 });

    const app = buildApp();
    const first = await request(app).get('/api/v1/indexer/status');
    const second = await request(app).get('/api/v1/indexer/status');

    expect(first.status).toBe(200);
    expect(first.headers['x-ratelimit-limit']).toBe('1');
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('RATE_LIMITED');
  });
});
