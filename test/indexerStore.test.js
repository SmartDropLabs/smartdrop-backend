'use strict';

const mockStore = new Map();
const mockSets = new Map();

const mockRedis = {
  smembers: jest.fn(async (key) => [...(mockSets.get(key) || [])]),
  sadd: jest.fn(async (key, val) => {
    if (!mockSets.has(key)) mockSets.set(key, new Set());
    mockSets.get(key).add(val);
  }),
};

jest.mock('../src/services/cache', () => ({
  getClient: () => mockRedis,
  get: jest.fn(async (key) => {
    const value = mockStore.get(key);
    return value !== undefined ? JSON.parse(JSON.stringify(value)) : null;
  }),
  set: jest.fn(async (key, value) => {
    mockStore.set(key, JSON.parse(JSON.stringify(value)));
  }),
  del: jest.fn(async (key) => {
    mockStore.delete(key);
  }),
}));

const eventStore = require('../src/indexer/eventStore');

function baseEvent(overrides) {
  return {
    id: overrides.id,
    event_name: overrides.event_name,
    ledger: overrides.ledger || 100,
    ledger_closed_at: '2026-06-25T00:00:00Z',
    data: overrides.data,
  };
}

beforeEach(() => {
  mockStore.clear();
  mockSets.clear();
  mockRedis.smembers.mockClear();
  mockRedis.sadd.mockClear();
});

describe('indexer event store', () => {
  test('persists airdrop lifecycle, recipients, claims, and stats', async () => {
    await eventStore.saveEvent(baseEvent({
      id: 'evt-created',
      event_name: 'airdrop_created',
      ledger: 10,
      data: {
        airdrop_id: 'drop-1',
        creator: 'GCREATOR',
        token: 'USDC',
        total_amount: '1000',
        expiry_ledger: '500',
      },
    }));
    await eventStore.saveEvent(baseEvent({
      id: 'evt-recipient',
      event_name: 'recipient_added',
      ledger: 11,
      data: {
        airdrop_id: 'drop-1',
        recipient: 'GRECIPIENT',
        amount: '250',
      },
    }));
    await eventStore.saveEvent(baseEvent({
      id: 'evt-claim',
      event_name: 'token_claimed',
      ledger: 12,
      data: {
        airdrop_id: 'drop-1',
        recipient: 'GRECIPIENT',
        amount: '250',
        ledger: '12',
      },
    }));
    await eventStore.saveEvent(baseEvent({
      id: 'evt-expired',
      event_name: 'airdrop_expired',
      ledger: 13,
      data: {
        airdrop_id: 'drop-1',
        unclaimed_amount: '750',
      },
    }));
    await eventStore.setLastLedger(13);

    const status = await eventStore.getAirdropStatus('drop-1');
    expect(status).toMatchObject({
      airdrop_id: 'drop-1',
      status: 'expired',
      total_amount: '1000',
      recipients_count: 1,
      claimed_count: 1,
      pending_count: 0,
      unclaimed_amount: '750',
    });

    await expect(eventStore.getAirdropRecipients('drop-1')).resolves.toEqual([
      expect.objectContaining({ recipient: 'GRECIPIENT', status: 'claimed', amount: '250' }),
    ]);
    await expect(eventStore.getRecipientClaims('GRECIPIENT')).resolves.toEqual([
      expect.objectContaining({ event_id: 'evt-claim', airdrop_id: 'drop-1', amount: '250' }),
    ]);
    await expect(eventStore.getStats()).resolves.toMatchObject({
      last_ledger: 13,
      events_count: 4,
    });
  });
});
