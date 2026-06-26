'use strict';

const mockStore = new Map();
const mockSets = new Map();
const mockLists = new Map();

const mockRedis = {
  smembers: jest.fn(async (key) => [...(mockSets.get(key) || [])]),
  sadd: jest.fn(async (key, val) => {
    if (!mockSets.has(key)) mockSets.set(key, new Set());
    mockSets.get(key).add(val);
  }),
  srem: jest.fn(async (key, val) => {
    mockSets.get(key)?.delete(val);
  }),
  llen: jest.fn(async (key) => (mockLists.get(key) || []).length),
  lpush: jest.fn(async (key, ...vals) => {
    if (!mockLists.has(key)) mockLists.set(key, []);
    mockLists.get(key).unshift(...vals);
  }),
  rpush: jest.fn(async (key, ...vals) => {
    if (!mockLists.has(key)) mockLists.set(key, []);
    mockLists.get(key).push(...vals);
  }),
  lrange: jest.fn(async (key, start, end) => {
    const list = mockLists.get(key) || [];
    return list.slice(start, end + 1);
  }),
};

jest.mock('../src/services/cache', () => ({
  getClient: () => mockRedis,
  get: jest.fn(async (key) => {
    const v = mockStore.get(key);
    return v !== undefined ? JSON.parse(JSON.stringify(v)) : null;
  }),
  set: jest.fn(async (key, value) => {
    mockStore.set(key, JSON.parse(JSON.stringify(value)));
  }),
  del: jest.fn(async (key) => {
    mockStore.delete(key);
    mockLists.delete(key);
  }),
}));

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const mockLedger = { sequence: 12345 };
jest.mock('stellar-sdk', () => ({
  Horizon: {
    Server: jest.fn(() => ({
      ledgers: jest.fn(() => ({
        order: jest.fn(() => ({
          limit: jest.fn(() => ({
            call: jest.fn(async () => ({ records: [mockLedger] })),
          })),
        })),
      })),
    })),
  },
  StrKey: {
    isValidEd25519PublicKey: jest.fn((address) => address.startsWith('G') && address.length === 56),
  },
}));

const request = require('supertest');
const cache = require('../src/services/cache');
let app;

beforeAll(() => {
  app = require('../src/index').app;
});

beforeEach(() => {
  mockStore.clear();
  mockSets.clear();
  mockLists.clear();
  cache.get.mockClear();
  cache.set.mockClear();
  cache.del.mockClear();
  mockRedis.smembers.mockClear();
  mockRedis.sadd.mockClear();
  mockRedis.srem.mockClear();
  mockRedis.llen.mockClear();
  mockRedis.lpush.mockClear();
  mockRedis.rpush.mockClear();
  mockRedis.lrange.mockClear();
});

const validAddress1 = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const validAddress2 = 'GDRREYWHQWJDICNH4SAH4TT2JPVYWIX6JEWAHE2W6BZDJBIJ4VSX227Z';

describe('POST /api/v1/airdrops', () => {
  test('creates airdrop successfully', async () => {
    const response = await request(app)
      .post('/api/v1/airdrops')
      .send({
        name: 'Test Airdrop',
        description: 'Test Description',
        asset: 'USDC',
        asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA',
        total_amount: 100,
        expiry_ledger: 123456,
        recipients: [
          { address: validAddress1, amount: 50 },
          { address: validAddress2, amount: 50 },
        ],
      });
    console.log('POST /airdrops response status:', response.status);
    console.log('POST /airdrops response body:', response.body);
    console.log('mockStore contents after POST:', Array.from(mockStore.entries()));
    console.log('mockSets contents after POST:', Array.from(mockSets.entries()));
    expect(response.status).toBe(201);
    expect(response.body.id).toMatch(/^drop_/);
    expect(response.body.name).toBe('Test Airdrop');
  });

  test('returns validation error for invalid Stellar address', async () => {
    const response = await request(app)
      .post('/api/v1/airdrops')
      .send({
        name: 'Test Airdrop',
        asset: 'USDC',
        asset_issuer: 'invalid',
        total_amount: 100,
        expiry_ledger: 123456,
      });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation error');
  });

  test('returns validation error when sum of recipients does not equal total_amount', async () => {
    const response = await request(app)
      .post('/api/v1/airdrops')
      .send({
        name: 'Test Airdrop',
        asset: 'USDC',
        asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA',
        total_amount: 100,
        expiry_ledger: 123456,
        recipients: [{ address: validAddress1, amount: 50 }],
      });
    expect(response.status).toBe(400);
    expect(response.body.message).toContain('sum of recipient amounts');
  });
});

describe('GET /api/v1/airdrops', () => {
  test('lists airdrops with pagination', async () => {
    console.log('=== Test: lists airdrops with pagination ===');
    console.log('Before first POST: mockStore', Array.from(mockStore.entries()));
    console.log('Before first POST: mockSets', Array.from(mockSets.entries()));

    const res1 = await request(app)
      .post('/api/v1/airdrops')
      .send({
        name: 'Airdrop 1',
        asset: 'USDC',
        asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA',
        total_amount: 100,
        expiry_ledger: 123456,
      });
    console.log('First POST res status:', res1.status);
    console.log('First POST res body:', res1.body);

    console.log('After first POST: mockStore', Array.from(mockStore.entries()));
    console.log('After first POST: mockSets', Array.from(mockSets.entries()));

    const res2 = await request(app)
      .post('/api/v1/airdrops')
      .send({
        name: 'Airdrop 2',
        asset: 'XLM',
        asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA',
        total_amount: 200,
        expiry_ledger: 123457,
      });
    console.log('Second POST res status:', res2.status);

    console.log('After second POST: mockStore', Array.from(mockStore.entries()));
    console.log('After second POST: mockSets', Array.from(mockSets.entries()));

    const response = await request(app).get('/api/v1/airdrops?page=1&limit=2');
    console.log('GET /airdrops response body:', response.body);
    expect(response.status).toBe(200);
    expect(response.body.airdrops).toHaveLength(2);
    expect(response.body.pagination.total).toBe(2);
  });
});

describe('GET /api/v1/airdrops/:id', () => {
  test('returns airdrop by id', async () => {
    const createResponse = await request(app)
      .post('/api/v1/airdrops')
      .send({
        name: 'Test Airdrop',
        asset: 'USDC',
        asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA',
        total_amount: 100,
        expiry_ledger: 123456,
      });

    const getResponse = await request(app).get(`/api/v1/airdrops/${createResponse.body.id}`);
    expect(getResponse.status).toBe(200);
    expect(getResponse.body.id).toBe(createResponse.body.id);
  });

  test('returns 404 for non-existent airdrop', async () => {
    const response = await request(app).get('/api/v1/airdrops/drop_nonexistent');
    expect(response.status).toBe(404);
  });
});

describe('PATCH /api/v1/airdrops/:id', () => {
  test('updates airdrop successfully', async () => {
    const createResponse = await request(app)
      .post('/api/v1/airdrops')
      .send({
        name: 'Test Airdrop',
        asset: 'USDC',
        asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA',
        total_amount: 100,
        expiry_ledger: 123456,
      });

    const updateResponse = await request(app)
      .patch(`/api/v1/airdrops/${createResponse.body.id}`)
      .send({ name: 'Updated Airdrop', description: 'Updated Description' });

    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.name).toBe('Updated Airdrop');
    expect(updateResponse.body.description).toBe('Updated Description');
  });
});

describe('DELETE /api/v1/airdrops/:id', () => {
  test('deletes airdrop successfully', async () => {
    const createResponse = await request(app)
      .post('/api/v1/airdrops')
      .send({
        name: 'Test Airdrop',
        asset: 'USDC',
        asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA',
        total_amount: 100,
        expiry_ledger: 123456,
      });

    const deleteResponse = await request(app).delete(`/api/v1/airdrops/${createResponse.body.id}`);
    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.body.deleted).toBe(true);
  });
});

describe('POST /api/v1/airdrops/:id/cancel', () => {
  test('cancels airdrop successfully', async () => {
    const createResponse = await request(app)
      .post('/api/v1/airdrops')
      .send({
        name: 'Test Airdrop',
        asset: 'USDC',
        asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA',
        total_amount: 100,
        expiry_ledger: 123456,
      });

    const cancelResponse = await request(app).post(`/api/v1/airdrops/${createResponse.body.id}/cancel`);
    expect(cancelResponse.status).toBe(200);
    expect(cancelResponse.body.status).toBe('cancelled');
  });

  test('idempotent cancellation', async () => {
    const createResponse = await request(app)
      .post('/api/v1/airdrops')
      .send({
        name: 'Test Airdrop',
        asset: 'USDC',
        asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA',
        total_amount: 100,
        expiry_ledger: 123456,
      });

    await request(app).post(`/api/v1/airdrops/${createResponse.body.id}/cancel`);
    const secondCancelResponse = await request(app).post(`/api/v1/airdrops/${createResponse.body.id}/cancel`);
    expect(secondCancelResponse.status).toBe(200);
  });
});

describe('POST /api/v1/airdrops/:id/recipients', () => {
  test('adds recipients successfully', async () => {
    const createResponse = await request(app)
      .post('/api/v1/airdrops')
      .send({
        name: 'Test Airdrop',
        asset: 'USDC',
        asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA',
        total_amount: 100,
        expiry_ledger: 123456,
      });

    const addResponse = await request(app)
      .post(`/api/v1/airdrops/${createResponse.body.id}/recipients`)
      .send({ recipients: [{ address: validAddress1, amount: 50 }] });

    expect(addResponse.status).toBe(201);
    expect(addResponse.body.added).toBe(1);
  });

  test('parses CSV file successfully', async () => {
    const createResponse = await request(app)
      .post('/api/v1/airdrops')
      .send({
        name: 'Test Airdrop',
        asset: 'USDC',
        asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA',
        total_amount: 100,
        expiry_ledger: 123456,
      });

    const csvContent = 'address,amount\n' + validAddress1 + ',50\n' + validAddress2 + ',50';
    const addResponse = await request(app)
      .post(`/api/v1/airdrops/${createResponse.body.id}/recipients`)
      .attach('file', Buffer.from(csvContent), 'recipients.csv');

    expect(addResponse.status).toBe(201);
    expect(addResponse.body.added).toBe(2);
  });
});

describe('GET /api/v1/airdrops/:id/recipients', () => {
  test('lists recipients with pagination', async () => {
    const createResponse = await request(app)
      .post('/api/v1/airdrops')
      .send({
        name: 'Test Airdrop',
        asset: 'USDC',
        asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA',
        total_amount: 100,
        expiry_ledger: 123456,
        recipients: [
          { address: validAddress1, amount: 50 },
          { address: validAddress2, amount: 50 },
        ],
      });

    const listResponse = await request(app).get(`/api/v1/airdrops/${createResponse.body.id}/recipients`);
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.recipients).toHaveLength(2);
  });
});
