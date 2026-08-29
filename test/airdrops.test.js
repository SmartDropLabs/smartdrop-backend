'use strict';

const mockStore = new Map();
const mockSets = new Map();
const mockZSets = new Map();
const mockLists = new Map();
const mockCounters = new Map();

const mockRedis = {
  smembers: jest.fn(async (key) => [...(mockSets.get(key) || [])]),
  sadd: jest.fn(async (key, val) => {
    if (!mockSets.has(key)) mockSets.set(key, new Set());
    mockSets.get(key).add(val);
  }),
  srem: jest.fn(async (key, val) => {
    mockSets.get(key)?.delete(val);
  }),
  zadd: jest.fn(async (key, score, member) => {
    if (!mockZSets.has(key)) mockZSets.set(key, new Map());
    mockZSets.get(key).set(member, Number(score));
  }),
  zrem: jest.fn(async (key, ...members) => {
    const z = mockZSets.get(key);
    if (!z) return;
    for (const m of members) z.delete(m);
  }),
  zrevrange: jest.fn(async (key, start, stop) => {
    const z = mockZSets.get(key);
    if (!z) return [];
    const sorted = [...z.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
    const end = stop === -1 ? sorted.length : stop + 1;
    return sorted.slice(start, end);
  }),
  zcard: jest.fn(async (key) => (mockZSets.get(key)?.size || 0)),
  zscan: jest.fn(async (key, cursor, _countKeyword, count) => {
    const entries = [...(mockZSets.get(key)?.entries() || [])];
    const batchWithScores = [];
    const start = Number(cursor);
    for (let i = start; i < start + count && i < entries.length; i += 1) {
      batchWithScores.push(entries[i][0], entries[i][1]);
    }
    const nextCursor = start + count >= entries.length ? '0' : String(start + count);
    return [nextCursor, batchWithScores];
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
    const startIdx = start === -1 ? list.length + start : start;
    const endIdx = end === -1 ? list.length + end : end;
    return list.slice(startIdx, endIdx + 1);
  }),
  incr: jest.fn(async (key) => {
    const count = (mockCounters.get(key) || 0) + 1;
    mockCounters.set(key, count);
    return count;
  }),
  expire: jest.fn(async () => 1),
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
  SorobanRpc: {
    Server: jest.fn(() => ({})),
  },
}));

const request = require('supertest');
const cache = require('../src/services/cache');
const config = require('../src/config');
let app;

beforeAll(() => {
  app = require('../src/index').app;
});

beforeEach(() => {
  mockStore.clear();
  mockSets.clear();
  mockZSets.clear();
  mockLists.clear();
  mockCounters.clear();
  cache.get.mockClear();
  cache.set.mockClear();
  cache.del.mockClear();
  mockRedis.smembers.mockClear();
  mockRedis.sadd.mockClear();
  mockRedis.srem.mockClear();
  mockRedis.zadd.mockClear();
  mockRedis.zrem.mockClear();
  mockRedis.zcard.mockClear();
  mockRedis.zrevrange.mockClear();
  mockRedis.zrevrange.mockClear();
  mockRedis.zcard.mockClear();
  mockRedis.zscan.mockClear();
  mockRedis.llen.mockClear();
  mockRedis.lpush.mockClear();
  mockRedis.rpush.mockClear();
  mockRedis.lrange.mockClear();
  mockRedis.incr.mockClear();
  mockRedis.expire.mockClear();
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
        expiry_ledger: 123456, // Greater than mockLedger.sequence (12345)
        recipients: [
          { address: validAddress1, amount: 50 },
          { address: validAddress2, amount: 50 },
        ],
      });
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
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
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
    expect(response.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
    });
    expect(response.body.error.details.fields.recipients).toEqual(
      expect.arrayContaining([expect.stringContaining('sum of recipient amounts')])
    );
  });

  test('rate limits repeated airdrop creation attempts', async () => {
    for (let i = 0; i < config.airdrops.rateLimit.max; i += 1) {
      const response = await request(app).post('/api/v1/airdrops').send({});
      expect(response.status).toBe(400);
    }

    const blocked = await request(app).post('/api/v1/airdrops').send({});
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('GET /api/v1/airdrops', () => {
  test('lists airdrops with pagination', async () => {
    const res1 = await request(app)
    await request(app)
      .post('/api/v1/airdrops')
      .send({
        name: 'Airdrop 1',
        asset: 'USDC',
        asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA',
        total_amount: 100,
        expiry_ledger: 123456,
      });

    const res2 = await request(app)
    await request(app)
      .post('/api/v1/airdrops')
      .send({
        name: 'Airdrop 2',
        asset: 'XLM',
        asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA',
        total_amount: 200,
        expiry_ledger: 123457,
      });

    const response = await request(app).get('/api/v1/airdrops?page=1&limit=2');
    expect(response.status).toBe(200);
    // Canonical pagination envelope (#131): array under `data`, not `airdrops`.
    expect(response.body.data).toHaveLength(2);
    expect(response.body.pagination.total).toBe(2);
    expect(response.body.pagination.has_next).toBe(false);
    expect(response.body.pagination.has_prev).toBe(false);
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

  test('rejects a CSV larger than the configured upload limit', async () => {
    const createResponse = await request(app)
      .post('/api/v1/airdrops')
      .send({
        name: 'Test Airdrop',
        asset: 'USDC',
        asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA',
        total_amount: 100,
        expiry_ledger: 123456,
      });

    const oversized = Buffer.alloc(config.airdrops.csvMaxBytes + 1, 'a');
    const response = await request(app)
      .post(`/api/v1/airdrops/${createResponse.body.id}/recipients`)
      .attach('file', oversized, 'recipients.csv');

    expect(response.status).toBe(413);
    expect(response.body.error).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      details: { max_bytes: config.airdrops.csvMaxBytes },
    });
    expect(mockRedis.rpush).not.toHaveBeenCalled();
  });

  test('stops CSV parsing when the 10,000-row limit is crossed', async () => {
    const createResponse = await request(app)
      .post('/api/v1/airdrops')
      .send({
        name: 'Test Airdrop',
        asset: 'USDC',
        asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA',
        total_amount: 100,
        expiry_ledger: 123456,
      });
    const row = `${validAddress1},1\n`;
    const csvContent = `address,amount\n${row.repeat(10001)}`;

    const response = await request(app)
      .post(`/api/v1/airdrops/${createResponse.body.id}/recipients`)
      .attach('file', Buffer.from(csvContent), 'recipients.csv');

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: 'RECIPIENT_LIMIT_EXCEEDED',
      message: 'CSV cannot exceed 10000 recipients',
    });
    expect(mockRedis.rpush).not.toHaveBeenCalled();
  });

  test('rejects a CSV file with non-UTF-8 encoding', async () => {
    const createResponse = await request(app)
      .post('/api/v1/airdrops')
      .send({
        name: 'Test Airdrop',
        asset: 'USDC',
        asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA',
        total_amount: 100,
        expiry_ledger: 123456,
      });

    const invalidUtf8Buffer = Buffer.from([0x61, 0x64, 0x64, 0x72, 0x65, 0x73, 0x73, 0x2c, 0x61, 0x6d, 0x6f, 0x75, 0x6e, 0x74, 0x0a, 0xa0, 0xa1, 0xc0]);
    const response = await request(app)
      .post(`/api/v1/airdrops/${createResponse.body.id}/recipients`)
      .attach('file', invalidUtf8Buffer, 'recipients.csv');

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: 'CSV_INVALID_ENCODING',
      message: expect.stringContaining('UTF-8'),
    });
  });

  test('rate limits repeated recipient additions', async () => {
    const createResponse = await request(app)
      .post('/api/v1/airdrops')
      .send({
        name: 'Test Airdrop',
        asset: 'USDC',
        asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA',
        total_amount: 100,
        expiry_ledger: 123456,
      });
    const endpoint = `/api/v1/airdrops/${createResponse.body.id}/recipients`;

    for (let i = 0; i < config.airdrops.rateLimit.max; i += 1) {
      const response = await request(app)
        .post(endpoint)
        .send({ recipients: [{ address: validAddress1, amount: 1 }] });
      expect(response.status).toBe(201);
    }

    const blocked = await request(app)
      .post(endpoint)
      .send({ recipients: [{ address: validAddress1, amount: 1 }] });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
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
    // Canonical pagination envelope (#131): array under `data`, not `recipients`.
    expect(listResponse.body.data).toHaveLength(2);
    expect(listResponse.body.pagination.total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// CSV structure validation (issue #254)
// ---------------------------------------------------------------------------

describe('POST /api/v1/airdrops/:id/recipients — CSV structure validation', () => {
  async function createAirdrop() {
    const res = await request(app)
      .post('/api/v1/airdrops')
      .send({
        name: 'Test Airdrop',
        asset: 'USDC',
        asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA',
        total_amount: 100,
        expiry_ledger: 123456,
      });
    return res.body.id;
  }

  async function uploadCsv(id, content) {
    return request(app)
      .post(`/api/v1/airdrops/${id}/recipients`)
      .attach('file', Buffer.from(content), 'recipients.csv');
  }

  test('rejects a CSV whose required columns are missing', async () => {
    const id = await createAirdrop();

    const res = await uploadCsv(id, `wallet,value
${validAddress1},50`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CSV_MISSING_COLUMNS');
    expect(res.body.error.details.missing_columns).toEqual(
      expect.arrayContaining(['address', 'amount']),
    );
  });

  test('names only the column that is actually missing', async () => {
    const id = await createAirdrop();

    const res = await uploadCsv(id, `address,value
${validAddress1},50`);

    expect(res.body.error.details.missing_columns).toEqual(['amount']);
  });

  test('accepts columns regardless of case and surrounding whitespace', async () => {
    const id = await createAirdrop();

    const res = await uploadCsv(id, ` Address , AMOUNT 
${validAddress1},50`);

    expect(res.status).toBe(201);
  });

  test('rejects a CSV with no data rows instead of importing nothing silently', async () => {
    const id = await createAirdrop();

    const res = await uploadCsv(id, 'address,amount');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CSV_EMPTY');
  });

  test('reports rows whose amount is not a number rather than dropping them', async () => {
    const id = await createAirdrop();

    const res = await uploadCsv(id, `address,amount
${validAddress1},not-a-number`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CSV_MALFORMED');
    expect(res.body.error.details.invalid_rows).toEqual([
      { line: 2, reason: 'amount is not a number' },
    ]);
  });

  test('reports rows with a missing address', async () => {
    const id = await createAirdrop();

    const res = await uploadCsv(id, 'address,amount\n,50');

    expect(res.body.error.details.invalid_rows).toEqual([
      { line: 2, reason: 'missing address' },
    ]);
  });

  test('reports rows whose amount is zero or negative', async () => {
    const id = await createAirdrop();

    const res = await uploadCsv(id, `address,amount
${validAddress1},0`);

    expect(res.body.error.details.invalid_rows).toEqual([
      { line: 2, reason: 'amount must be greater than zero' },
    ]);
  });

  test('line numbers account for the header, matching a text editor', async () => {
    const id = await createAirdrop();

    const res = await uploadCsv(
      id,
      `address,amount
${validAddress1},50
${validAddress2},bad`,
    );

    expect(res.body.error.details.invalid_rows).toEqual([
      { line: 3, reason: 'amount is not a number' },
    ]);
  });

  test('rejects the whole upload rather than partially importing a mixed file', async () => {
    const id = await createAirdrop();

    const res = await uploadCsv(
      id,
      `address,amount
${validAddress1},50
${validAddress2},bad`,
    );

    expect(res.status).toBe(400);
    expect(res.body.error.details.valid_rows).toBe(1);
    expect(res.body.error.details.total_rows).toBe(2);
    expect(mockRedis.rpush).not.toHaveBeenCalled();
  });

  test('caps how many invalid rows are echoed back to the uploader', async () => {
    const id = await createAirdrop();
    const rows = Array.from({ length: 40 }, () => ',0').join('\n');

    const res = await uploadCsv(id, `address,amount
${rows}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CSV_MALFORMED');
    expect(res.body.error.details.truncated).toBe(true);
    expect(res.body.error.details.invalid_rows.length).toBeLessThanOrEqual(20);
  });

  test('still accepts a fully valid CSV', async () => {
    const id = await createAirdrop();

    const res = await uploadCsv(
      id,
      `address,amount
${validAddress1},50
${validAddress2},25.5`,
    );

    expect(res.status).toBe(201);
    expect(res.body.added).toBe(2);
  });
});
