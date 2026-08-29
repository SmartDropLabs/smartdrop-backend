'use strict';

/**
 * Contract test for #131: every list endpoint in the public API must
 * return the same pagination envelope shape —
 * src/schemas/pagination.js's paginatedResponseSchema, picked as
 * canonical since it's the shape already partially in use (GET /alerts)
 * and already defined in code, just not consistently applied.
 *
 * Boots the real app (mirroring test/airdrops.test.js's pattern) with
 * only cache/logger/stellar-sdk/eventStore mocked, and validates each
 * list endpoint's actual response against the schema directly —
 * matching the issue's own suggested test plan
 * (`paginatedResponseSchema.safeParse(response.body)`) rather than
 * asserting on individual fields, so a future endpoint that
 * reintroduces a sixth shape fails here regardless of which field it
 * gets wrong.
 */

const { createCacheMock } = require('./helpers/cacheMock');
const mockCacheHelper = createCacheMock();

jest.mock('../src/services/cache', () => mockCacheHelper.cacheMock);

jest.mock('../src/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
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

const mockGetAirdropRecipients = jest.fn();
const mockGetRecipientClaims = jest.fn();
jest.mock('../src/indexer/eventStore', () => ({
  getAirdropStatus: jest.fn(),
  getAirdropRecipients: mockGetAirdropRecipients,
  getRecipientClaims: mockGetRecipientClaims,
  getStats: jest.fn(async () => ({ last_ledger: 0, events_count: 0 })),
}));

jest.mock('../src/indexer/runtime', () => ({
  start: jest.fn(),
  getStatus: jest.fn(() => ({
    enabled: false, configured: false, running: false, contract_id: null,
    poll_interval_ms: 5000, poll_limit: 100, last_run: null, last_error: null,
    latest_ledger: null,
  })),
}));

const adminApiKey = 'a'.repeat(64);
process.env.ADMIN_API_KEY = adminApiKey;

const request = require('supertest');
const { paginatedResponseSchema } = require('../src/schemas/pagination');

let app;

beforeAll(() => {
  app = require('../src/index').app;
});

beforeEach(() => {
  mockCacheHelper.reset();
  mockGetAirdropRecipients.mockReset();
  mockGetRecipientClaims.mockReset();
});

function expectValidPaginationEnvelope(body) {
  const result = paginatedResponseSchema.safeParse(body);
  if (!result.success) {
    throw new Error(
      `Response does not match the canonical pagination envelope: ${JSON.stringify(result.error.issues)}\n` +
      `Received: ${JSON.stringify(body)}`,
    );
  }
}

async function createAirdrop() {
  const res = await request(app).post('/api/v1/airdrops').send({
    name: 'Contract test airdrop',
    asset: 'USDC',
    asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA',
    total_amount: 100,
    expiry_ledger: 123456,
  });
  return res.body.id;
}

describe('pagination envelope contract (#131)', () => {
  test('GET /airdrops matches the canonical envelope', async () => {
    await createAirdrop();
    const res = await request(app).get('/api/v1/airdrops');
    expect(res.status).toBe(200);
    expectValidPaginationEnvelope(res.body);
  });

  test('GET /airdrops/:id/recipients matches the canonical envelope', async () => {
    const airdropId = await createAirdrop();
    const validAddress = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA';
    await request(app)
      .post(`/api/v1/airdrops/${airdropId}/recipients`)
      .send({ recipients: [{ address: validAddress, amount: 50 }] });

    const res = await request(app).get(`/api/v1/airdrops/${airdropId}/recipients`);
    expect(res.status).toBe(200);
    expectValidPaginationEnvelope(res.body);
  });

  test('GET /webhooks matches the canonical envelope', async () => {
    await request(app)
      .post('/api/v1/webhooks')
      .set('Authorization', `Bearer ${adminApiKey}`)
      .send({
        url: 'https://example.com/hook',
        events: ['*'],
        secret: 'whsec_aaaaaaaaaaaaaaaa',
      });

    const res = await request(app)
      .get('/api/v1/webhooks')
      .set('Authorization', `Bearer ${adminApiKey}`);
    expect(res.status).toBe(200);
    expectValidPaginationEnvelope(res.body);
  });

  test('GET /alerts matches the canonical envelope', async () => {
    const res = await request(app)
      .get('/api/v1/alerts')
      .set('Authorization', `Bearer ${adminApiKey}`);
    expect(res.status).toBe(200);
    expectValidPaginationEnvelope(res.body);
  });

  test('GET /airdrops/:id/onchain-recipients matches the canonical envelope', async () => {
    mockGetAirdropRecipients.mockResolvedValue([{ recipient: 'GRECIPIENT', status: 'claimed' }]);
    const res = await request(app).get('/api/v1/airdrops/drop-1/onchain-recipients');
    expect(res.status).toBe(200);
    expectValidPaginationEnvelope(res.body);
  });

  test('GET /recipients/:address/claims matches the canonical envelope', async () => {
    mockGetRecipientClaims.mockResolvedValue([{ airdrop_id: 'drop-1', amount: '25' }]);
    const res = await request(app).get('/api/v1/recipients/GRECIPIENT12345/claims');
    expect(res.status).toBe(200);
    expectValidPaginationEnvelope(res.body);
  });
});
