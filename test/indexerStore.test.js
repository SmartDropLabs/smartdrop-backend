'use strict';

// Raw string store — the single source of truth cache.get/set/del and raw
// redis.get/set/del/type/hset/hget/hgetall all read and write through, the
// same way one real Redis instance backs both the JSON-wrapping cache.js
// API and the raw ioredis client cache.getClient() returns. Issues #352-354
// each move a former cache.set()-based write onto the raw client (inside a
// MULTI transaction, or — for #353 — a hash field instead of a whole-list
// string) precisely so it's atomic with the write next to it; a mock that
// kept cache.set/get and redis.* on two disconnected stores would make
// those two code paths invisible to each other here even though in
// production they are the exact same Redis keyspace.
const mockStore = new Map();
const mockSets = new Map();
const mockHashes = new Map();

function getHash(key) {
  if (!mockHashes.has(key)) mockHashes.set(key, new Map());
  return mockHashes.get(key);
}

function makeChain() {
  const queue = [];
  const proxy = new Proxy({}, {
    get(target, prop) {
      if (prop === 'exec') {
        return async () => {
          const results = [];
          for (const [cmd, args] of queue) results.push([null, await mockRedis[cmd](...args)]);
          return results;
        };
      }
      return (...args) => {
        queue.push([prop, args]);
        return proxy;
      };
    },
  });
  return proxy;
}

const mockRedis = {
  smembers: jest.fn(async (key) => [...(mockSets.get(key) || [])]),
  sadd: jest.fn(async (key, val) => {
    if (!mockSets.has(key)) mockSets.set(key, new Set());
    mockSets.get(key).add(val);
  }),
  set: jest.fn(async (key, value) => { mockStore.set(key, String(value)); mockHashes.delete(key); }),
  get: jest.fn(async (key) => (mockStore.has(key) ? mockStore.get(key) : null)),
  del: jest.fn(async (key) => { mockStore.delete(key); mockHashes.delete(key); mockSets.delete(key); }),
  type: jest.fn(async (key) => {
    if (mockStore.has(key)) return 'string';
    if (mockHashes.has(key) && mockHashes.get(key).size > 0) return 'hash';
    if (mockSets.has(key) && mockSets.get(key).size > 0) return 'set';
    return 'none';
  }),
  hset: jest.fn(async (key, field, value) => { getHash(key).set(field, String(value)); }),
  hget: jest.fn(async (key, field) => {
    const h = mockHashes.get(key);
    return h && h.has(field) ? h.get(field) : null;
  }),
  hgetall: jest.fn(async (key) => {
    const h = mockHashes.get(key);
    return h ? Object.fromEntries(h.entries()) : {};
  }),
  multi: jest.fn(() => makeChain()),
  pipeline: jest.fn(() => makeChain()),
};

jest.mock('../src/services/cache', () => ({
  getClient: () => mockRedis,
  get: jest.fn(async (key) => {
    const raw = await mockRedis.get(key);
    return raw !== null ? JSON.parse(raw) : null;
  }),
  set: jest.fn(async (key, value) => { await mockRedis.set(key, JSON.stringify(value)); }),
  del: jest.fn(async (key) => { await mockRedis.del(key); }),
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
  mockHashes.clear();
  mockRedis.smembers.mockClear();
  mockRedis.sadd.mockClear();
  mockRedis.set.mockClear();
  mockRedis.get.mockClear();
  mockRedis.del.mockClear();
  mockRedis.type.mockClear();
  mockRedis.hset.mockClear();
  mockRedis.hget.mockClear();
  mockRedis.hgetall.mockClear();
  mockRedis.multi.mockClear();
  mockRedis.pipeline.mockClear();
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

  test('saveEvent writes the event record and its id-set membership in one MULTI/EXEC transaction (#352)', async () => {
    await eventStore.saveEvent(baseEvent({
      id: 'evt-1',
      event_name: 'airdrop_created',
      data: { airdrop_id: 'drop-multi', creator: 'GCREATOR' },
    }));

    expect(mockRedis.multi).toHaveBeenCalled();
    expect(await eventStore.getStats()).toMatchObject({ events_count: 1 });
  });

  test('upsertAirdrop (via saveEvent) writes the airdrop record and id-set membership in one MULTI/EXEC transaction (#354)', async () => {
    await eventStore.saveEvent(baseEvent({
      id: 'evt-1',
      event_name: 'airdrop_created',
      data: { airdrop_id: 'drop-multi', creator: 'GCREATOR' },
    }));

    // Two MULTI transactions this call: one for saveEvent's own event
    // record + EVENT_IDS_KEY (#352), one for upsertAirdrop's record +
    // AIRDROP_IDS_KEY (#354).
    expect(mockRedis.multi).toHaveBeenCalledTimes(2);
    const status = await eventStore.getAirdropStatus('drop-multi');
    expect(status).toMatchObject({ airdrop_id: 'drop-multi', status: 'created', creator: 'GCREATOR' });
  });

  test('upsertRecipient stores each recipient as its own hash field, not a whole-list read/write (#353)', async () => {
    await eventStore.saveEvent(baseEvent({
      id: 'evt-r1',
      event_name: 'recipient_added',
      data: { airdrop_id: 'drop-hash', recipient: 'GONE', amount: '100' },
    }));
    // The O(n)-list read (cache.get on the whole recipients key) must not
    // happen; only the O(1) hash field operations should.
    expect(mockRedis.hset).toHaveBeenCalledWith(
      'indexer:airdrop:drop-hash:recipients', 'GONE', expect.stringContaining('GONE')
    );

    await eventStore.saveEvent(baseEvent({
      id: 'evt-r2',
      event_name: 'recipient_added',
      data: { airdrop_id: 'drop-hash', recipient: 'GTWO', amount: '200' },
    }));

    // Updating GTWO must not disturb GONE's already-stored field.
    await eventStore.saveEvent(baseEvent({
      id: 'evt-r2-claim',
      event_name: 'token_claimed',
      data: { airdrop_id: 'drop-hash', recipient: 'GTWO', amount: '200', ledger: '50' },
    }));

    const recipients = await eventStore.getAirdropRecipients('drop-hash');
    expect(recipients).toHaveLength(2);
    expect(recipients.find((r) => r.recipient === 'GONE')).toMatchObject({ status: 'pending', amount: '100' });
    expect(recipients.find((r) => r.recipient === 'GTWO')).toMatchObject({ status: 'claimed', amount: '200' });
  });

  test('a recipients key written in the old JSON-list format is migrated transparently on first access (#353)', async () => {
    const cache = require('../src/services/cache');
    const key = 'indexer:airdrop:drop-legacy:recipients';
    // Simulate data written before this fix, under the old format: one
    // JSON-list string via cache.set (mirrors old setJsonList()).
    await cache.set(key, [
      { recipient: 'GLEGACY', amount: '50', status: 'pending', added_ledger: 5 },
    ]);
    expect(await mockRedis.type(key)).toBe('string');

    // Reading triggers the migration.
    const recipients = await eventStore.getAirdropRecipients('drop-legacy');
    expect(recipients).toEqual([
      expect.objectContaining({ recipient: 'GLEGACY', amount: '50', status: 'pending' }),
    ]);
    expect(await mockRedis.type(key)).toBe('hash');

    // A subsequent upsert on the now-migrated key must not throw WRONGTYPE
    // and must preserve the pre-existing recipient's data.
    await eventStore.saveEvent(baseEvent({
      id: 'evt-legacy-claim',
      event_name: 'token_claimed',
      data: { airdrop_id: 'drop-legacy', recipient: 'GLEGACY', amount: '50', ledger: '6' },
    }));
    const after = await eventStore.getAirdropRecipients('drop-legacy');
    expect(after).toEqual([
      expect.objectContaining({ recipient: 'GLEGACY', amount: '50', status: 'claimed' }),
    ]);
  });
});
