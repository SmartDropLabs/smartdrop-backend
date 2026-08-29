'use strict';

const mockStore = new Map();
const mockSets = new Map();
const mockZSets = new Map();
const mockLists = new Map();

// Faithfully mirrors MARK_EXPIRED_SCRIPT's condition/write logic in JS,
// since jest can't execute real Lua against a live Redis in this test
// environment. Operates on the same `mockStore` cache.get/set already use
// (real Redis: both the Lua script and cache.get/set ultimately read/write
// the one physical `airdrop:<id>` key) — kept as a literal translation of
// the script's checks, not a "smarter" reimplementation, to minimize the
// risk of this mock silently diverging from what the real script does.
const TERMINAL_STATUSES_FOR_MOCK = new Set(['completed', 'failed', 'cancelled', 'expired']);
function mockMarkExpiredEval(store, key, currentLedger, nowIso) {
  const airdrop = store.get(key);
  if (airdrop === undefined) return null;
  if (TERMINAL_STATUSES_FOR_MOCK.has(airdrop.status)) return null;
  if (!airdrop.expiry_ledger || Number(airdrop.expiry_ledger) > Number(currentLedger)) return null;
  const updated = { ...airdrop, status: 'expired', updated_at: nowIso };
  store.set(key, updated);
  return JSON.stringify(updated);
}

function getSortedZSetMembers(key) {
  const z = mockZSets.get(key);
  if (!z) return [];
  return [...z.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([member]) => member);
}

const mockRedis = {
  smembers: jest.fn(async (key) => [...(mockSets.get(key) || [])]),
  sadd: jest.fn(async (key, ...vals) => {
    if (!mockSets.has(key)) mockSets.set(key, new Set());
    const set = mockSets.get(key);
    let added = 0;
    for (const val of vals) {
      if (!set.has(val)) { set.add(val); added++; }
    }
    return added;
  }),
  srem: jest.fn(async (key, val) => {
    mockSets.get(key)?.delete(val);
  }),
  // Paginated cursor mock: indexes into the set's insertion order, returning
  // up to `count` members per call and a numeric cursor (as a string, like
  // real Redis) until exhausted, at which point it returns cursor '0'.
  sscan: jest.fn(async (key, cursor, _countKeyword, count) => {
    const members = [...(mockSets.get(key) || [])];
    const start = Number(cursor);
    const batch = members.slice(start, start + count);
    const nextCursor = start + count >= members.length ? '0' : String(start + count);
    return [nextCursor, batch];
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
    const sorted = getSortedZSetMembers(key);
    const end = stop === -1 ? sorted.length : stop + 1;
    return sorted.slice(start, end);
  }),
  zcard: jest.fn(async (key) => (mockZSets.get(key)?.size || 0)),
  zscan: jest.fn(async (key, cursor, _countKeyword, count) => {
    const entries = [...(mockZSets.get(key)?.entries() || [])];
    const batchWithScores = [];
    const start = Number(cursor);
    for (let i = start; i < start + count && i < entries.length; i++) {
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
    return list.slice(start, end + 1);
  }),
  // Only understands MARK_EXPIRED_SCRIPT's exact call shape
  // (eval(script, 1, key, currentLedger, nowIso)) — sufficient since
  // markExpired() is the only caller of redis.eval in this codebase.
  eval: jest.fn(async (_script, _numKeys, key, currentLedger, nowIso) =>
    mockMarkExpiredEval(mockStore, key, currentLedger, nowIso)
  ),
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
const mockHorizonCall = jest.fn(async () => ({ records: [mockLedger] }));
jest.mock('stellar-sdk', () => ({
  Horizon: {
    Server: jest.fn(() => ({
      ledgers: jest.fn(() => ({
        order: jest.fn(() => ({
          limit: jest.fn(() => ({
            call: mockHorizonCall,
          })),
        })),
      })),
    })),
  },
  StrKey: {
    isValidEd25519PublicKey: jest.fn((address) => address.startsWith('G') && address.length === 56),
  },
}));

const airdropsService = require('../src/services/airdrops');

beforeEach(() => {
  mockStore.clear();
  mockSets.clear();
  mockZSets.clear();
  mockLists.clear();
});

describe('airdrops service', () => {
  test('create and get airdrop', async () => {
    const airdrop = await airdropsService.create({
      name: 'Test',
      asset: 'USDC',
      asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA',
      total_amount: 100,
      expiry_ledger: 123456,
    });

    console.log('Created airdrop:', airdrop);
    console.log('mockStore contents:', Array.from(mockStore.entries()));
    console.log('mockSets contents:', Array.from(mockSets.entries()));

    const fetched = await airdropsService.get(airdrop.id);
    console.log('Fetched airdrop:', fetched);

    expect(fetched).not.toBeNull();
    expect(fetched.id).toBe(airdrop.id);
  });

  describe('getCurrentLedger caching (#88)', () => {
    beforeEach(() => {
      mockHorizonCall.mockClear();
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('reuses the cached ledger within the TTL instead of calling Horizon again', async () => {
      jest.resetModules();
      const freshService = require('../src/services/airdrops');

      const first = await freshService.getCurrentLedger();
      const second = await freshService.getCurrentLedger();

      expect(first).toBe(12345);
      expect(second).toBe(12345);
      expect(mockHorizonCall).toHaveBeenCalledTimes(1);
    });

    test('calls Horizon again once the cache TTL has elapsed', async () => {
      jest.resetModules();
      const freshService = require('../src/services/airdrops');

      await freshService.getCurrentLedger();
      jest.advanceTimersByTime(5001);
      await freshService.getCurrentLedger();

      expect(mockHorizonCall).toHaveBeenCalledTimes(2);
    });
  });

  describe('scanIds (#88)', () => {
    test('pages through every ID in the set across multiple ZSCAN batches', async () => {
      for (let i = 0; i < 5; i++) {
        await airdropsService.create({
          name: `Airdrop ${i}`,
          asset: 'USDC',
          asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA',
          total_amount: 100,
          expiry_ledger: 123456,
        });
      }

      const seen = [];
      for await (const batch of airdropsService.scanIds(2)) {
        seen.push(...batch);
      }

      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
      // Confirms it actually paged (more than one ZSCAN call for 5 items at
      // batch size 2), not just a single ZREVRANGE-style dump.
      expect(mockRedis.zscan.mock.calls.length).toBeGreaterThan(1);
    });

    test('yields nothing for an empty airdrop set', async () => {
      const seen = [];
      for await (const batch of airdropsService.scanIds(2)) {
        seen.push(...batch);
      }
      expect(seen).toHaveLength(0);
    });
  });

  describe('markExpired (#88)', () => {
    async function createAirdrop(overrides = {}) {
      return airdropsService.create({
        name: 'Test',
        asset: 'USDC',
        asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA',
        total_amount: 100,
        expiry_ledger: 100,
        ...overrides,
      });
    }

    test('transitions a draft airdrop past its expiry_ledger to expired', async () => {
      const airdrop = await createAirdrop({ expiry_ledger: 100 });

      const updated = await airdropsService.markExpired(airdrop.id, 150);

      expect(updated).not.toBeNull();
      expect(updated.status).toBe('expired');
      const stored = await airdropsService.get(airdrop.id);
      expect(stored.status).toBe('expired');
    });

    test('is a no-op for an airdrop not yet past its expiry_ledger', async () => {
      const airdrop = await createAirdrop({ expiry_ledger: 200 });

      const updated = await airdropsService.markExpired(airdrop.id, 150);

      expect(updated).toBeNull();
      const stored = await airdropsService.get(airdrop.id);
      expect(stored.status).toBe('draft');
    });

    test('is idempotent: a second call against an already-expired airdrop no-ops', async () => {
      const airdrop = await createAirdrop({ expiry_ledger: 100 });

      const firstCall = await airdropsService.markExpired(airdrop.id, 150);
      const secondCall = await airdropsService.markExpired(airdrop.id, 150);

      expect(firstCall).not.toBeNull();
      expect(secondCall).toBeNull();
    });

    test('does not transition an airdrop already in a terminal status', async () => {
      const airdrop = await createAirdrop({ expiry_ledger: 100 });
      await airdropsService.cancel(airdrop.id);

      const updated = await airdropsService.markExpired(airdrop.id, 150);

      expect(updated).toBeNull();
      const stored = await airdropsService.get(airdrop.id);
      expect(stored.status).toBe('cancelled');
    });

    test('returns null for a nonexistent airdrop id', async () => {
      const updated = await airdropsService.markExpired('drop_does_not_exist', 150);
      expect(updated).toBeNull();
    });
  });

  describe('create with initial recipients', () => {
    test('stores recipients and address set when provided', async () => {
      const recipients = [
        { address: 'GAAA', amount: '100' },
        { address: 'GBBB', amount: '200' },
      ];
      const airdrop = await airdropsService.create({
        name: 'Test Drop',
        asset: 'USDC',
        asset_issuer: 'GISSUER',
        total_amount: '300',
        expiry_ledger: 1000,
        recipients,
      });

      expect(airdrop.id).toMatch(/^drop_/);
      expect(mockRedis.rpush).toHaveBeenCalled();
      expect(mockRedis.sadd).toHaveBeenCalled();

      const addressSet = mockSets.get(`airdrop:${airdrop.id}:addresses`);
      expect(addressSet).toBeDefined();
      expect(addressSet.has('GAAA')).toBe(true);
      expect(addressSet.has('GBBB')).toBe(true);
    });

    test('creates without recipients when none provided', async () => {
      const airdrop = await airdropsService.create({
        name: 'Empty Drop',
        asset: 'USDC',
        asset_issuer: 'GISSUER',
        total_amount: '100',
        expiry_ledger: 1000,
      });
      expect(airdrop.id).toMatch(/^drop_/);
    });
  });

  describe('addRecipients', () => {
    test('adds new recipients and returns empty duplicates array', async () => {
      const airdrop = await airdropsService.create({
        name: 'Drop', asset: 'USDC', asset_issuer: 'GI', total_amount: '100', expiry_ledger: 1000,
      });

      const dupes = await airdropsService.addRecipients(airdrop.id, [
        { address: 'GAAA', amount: '50' },
        { address: 'GBBB', amount: '50' },
      ]);

      expect(dupes).toEqual([]);
      expect(mockRedis.rpush).toHaveBeenCalled();
    });

    test('detects duplicate addresses and rolls back new ones', async () => {
      const airdrop = await airdropsService.create({
        name: 'Drop', asset: 'USDC', asset_issuer: 'GI', total_amount: '100', expiry_ledger: 1000,
        recipients: [{ address: 'GAAA', amount: '50' }],
      });

      // Reset mocks to isolate this call
      mockRedis.sadd.mockClear();
      mockRedis.srem.mockClear();
      mockRedis.rpush.mockClear();

      const dupes = await airdropsService.addRecipients(airdrop.id, [
        { address: 'GAAA', amount: '50' },
        { address: 'GBBB', amount: '50' },
      ]);

      expect(dupes).toEqual(['GAAA']);
      // No rpush since there were duplicates
      expect(mockRedis.rpush).not.toHaveBeenCalled();
    });

    test('rolls back newly added addresses when some are duplicates', async () => {
      const airdrop = await airdropsService.create({
        name: 'Drop', asset: 'USDC', asset_issuer: 'GI', total_amount: '100', expiry_ledger: 1000,
        recipients: [{ address: 'GAAA', amount: '50' }],
      });

      mockRedis.sadd.mockClear();
      mockRedis.srem.mockClear();
      mockRedis.rpush.mockClear();

      const dupes = await airdropsService.addRecipients(airdrop.id, [
        { address: 'GAAA', amount: '50' },
        { address: 'GCCC', amount: '50' },
      ]);

      expect(dupes).toEqual(['GAAA']);
      // GCCC was newly added but rolled back because GAAA was a duplicate
      expect(mockRedis.srem).toHaveBeenCalled();
      expect(mockRedis.rpush).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    test('sets status to cancelled', async () => {
      const airdrop = await airdropsService.create({
        name: 'Drop', asset: 'USDC', asset_issuer: 'GI', total_amount: '100', expiry_ledger: 1000,
      });

      const cancelled = await airdropsService.cancel(airdrop.id);
      expect(cancelled.status).toBe('cancelled');

      const fetched = await airdropsService.get(airdrop.id);
      expect(fetched.status).toBe('cancelled');
    });

    test('returns airdrop as-is if already cancelled', async () => {
      const airdrop = await airdropsService.create({
        name: 'Drop', asset: 'USDC', asset_issuer: 'GI', total_amount: '100', expiry_ledger: 1000,
      });

      await airdropsService.cancel(airdrop.id);
      const result = await airdropsService.cancel(airdrop.id);
      expect(result.status).toBe('cancelled');
    });

    test('returns null for nonexistent airdrop', async () => {
      const result = await airdropsService.cancel('drop_nope');
      expect(result).toBeNull();
    });
  });

  describe('update', () => {
    test('updates name and description', async () => {
      const airdrop = await airdropsService.create({
        name: 'Old Name', asset: 'USDC', asset_issuer: 'GI', total_amount: '100', expiry_ledger: 1000,
      });

      const updated = await airdropsService.update(airdrop.id, {
        name: 'New Name',
        description: 'Updated description',
      });

      expect(updated.name).toBe('New Name');
      expect(updated.description).toBe('Updated description');
      expect(updated.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test('preserves unspecified fields', async () => {
      const airdrop = await airdropsService.create({
        name: 'Keep', asset: 'USDC', asset_issuer: 'GI', total_amount: '100', expiry_ledger: 1000,
      });

      const updated = await airdropsService.update(airdrop.id, { name: 'Changed' });
      expect(updated.name).toBe('Changed');
      expect(updated.asset).toBe('USDC');
      expect(updated.expiry_ledger).toBe(1000);
    });

    test('returns null for nonexistent airdrop', async () => {
      const result = await airdropsService.update('drop_nope', { name: 'X' });
      expect(result).toBeNull();
    });
  });

  describe('remove', () => {
    test('deletes airdrop and its associated data', async () => {
      const airdrop = await airdropsService.create({
        name: 'Drop', asset: 'USDC', asset_issuer: 'GI', total_amount: '100', expiry_ledger: 1000,
        recipients: [{ address: 'GAAA', amount: '50' }],
      });

      const removed = await airdropsService.remove(airdrop.id);
      expect(removed.id).toBe(airdrop.id);

      const fetched = await airdropsService.get(airdrop.id);
      expect(fetched).toBeNull();

      const ids = await airdropsService.list();
      expect(ids.airdrops).toHaveLength(0);
    });

    test('returns null for nonexistent airdrop', async () => {
      const result = await airdropsService.remove('drop_nope');
      expect(result).toBeNull();
    });
  });

  describe('list pagination', () => {
    test('returns paginated results', async () => {
      for (let i = 0; i < 5; i++) {
        await airdropsService.create({
          name: `Drop ${i}`, asset: 'USDC', asset_issuer: 'GI', total_amount: '100', expiry_ledger: 1000,
        });
      }

      const page1 = await airdropsService.list(1, 2);
      expect(page1.airdrops).toHaveLength(2);
      expect(page1.total).toBe(5);

      const page2 = await airdropsService.list(2, 2);
      expect(page2.airdrops).toHaveLength(2);

      const page3 = await airdropsService.list(3, 2);
      expect(page3.airdrops).toHaveLength(1);
    });

    test('returns empty for page beyond total', async () => {
      await airdropsService.create({
        name: 'Drop', asset: 'USDC', asset_issuer: 'GI', total_amount: '100', expiry_ledger: 1000,
      });

      const result = await airdropsService.list(10, 20);
      expect(result.airdrops).toHaveLength(0);
      expect(result.total).toBe(1);
    });
  });

  describe('listRecipients', () => {
    test('returns recipients for an airdrop', async () => {
      const airdrop = await airdropsService.create({
        name: 'Drop', asset: 'USDC', asset_issuer: 'GI', total_amount: '100', expiry_ledger: 1000,
        recipients: [
          { address: 'GAAA', amount: '50' },
          { address: 'GBBB', amount: '50' },
        ],
      });

      const result = await airdropsService.listRecipients(airdrop.id);
      expect(result.recipients).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    test('returns empty for airdrop with no recipients', async () => {
      const airdrop = await airdropsService.create({
        name: 'Drop', asset: 'USDC', asset_issuer: 'GI', total_amount: '100', expiry_ledger: 1000,
      });

      const result = await airdropsService.listRecipients(airdrop.id);
      expect(result.recipients).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe('TERMINAL_STATUSES', () => {
    test('contains expected terminal statuses', async () => {
      expect(airdropsService.TERMINAL_STATUSES.has('completed')).toBe(true);
      expect(airdropsService.TERMINAL_STATUSES.has('failed')).toBe(true);
      expect(airdropsService.TERMINAL_STATUSES.has('cancelled')).toBe(true);
      expect(airdropsService.TERMINAL_STATUSES.has('expired')).toBe(true);
      expect(airdropsService.TERMINAL_STATUSES.has('draft')).toBe(false);
    });
  });

  describe('cancel preserves recipients', () => {
    test('recipients remain accessible after cancelling', async () => {
      const airdrop = await airdropsService.create({
        name: 'Drop', asset: 'USDC', asset_issuer: 'GI', total_amount: '100', expiry_ledger: 1000,
        recipients: [{ address: 'GAAA', amount: '50' }, { address: 'GBBB', amount: '50' }],
      });

      await airdropsService.cancel(airdrop.id);

      const { recipients, total } = await airdropsService.listRecipients(airdrop.id);
      expect(total).toBe(2);
      expect(recipients).toHaveLength(2);
    });
  });

  describe('addRecipients with empty array', () => {
    test('returns empty duplicates for empty input', async () => {
      const airdrop = await airdropsService.create({
        name: 'Drop', asset: 'USDC', asset_issuer: 'GI', total_amount: '100', expiry_ledger: 1000,
      });

      const dupes = await airdropsService.addRecipients(airdrop.id, []);
      expect(dupes).toEqual([]);
    });
  });

  describe('listRecipients pagination', () => {
    test('paginates recipients', async () => {
      const airdrop = await airdropsService.create({
        name: 'Drop', asset: 'USDC', asset_issuer: 'GI', total_amount: '100', expiry_ledger: 1000,
        recipients: [
          { address: 'GAAA', amount: '10' },
          { address: 'GBBB', amount: '20' },
          { address: 'GCCC', amount: '30' },
        ],
      });

      const page1 = await airdropsService.listRecipients(airdrop.id, 1, 2);
      expect(page1.recipients).toHaveLength(2);
      expect(page1.total).toBe(3);

      const page2 = await airdropsService.listRecipients(airdrop.id, 2, 2);
      expect(page2.recipients).toHaveLength(1);
    });
  });

  describe('update contract_airdrop_id', () => {
    test('sets contract_airdrop_id', async () => {
      const airdrop = await airdropsService.create({
        name: 'Drop', asset: 'USDC', asset_issuer: 'GI', total_amount: '100', expiry_ledger: 1000,
      });

      const updated = await airdropsService.update(airdrop.id, { contract_airdrop_id: '0xabc123' });
      expect(updated.contract_airdrop_id).toBe('0xabc123');
    });
  });

  describe('create with contract_airdrop_id', () => {
    test('stores contract_airdrop_id when provided', async () => {
      const airdrop = await airdropsService.create({
        name: 'Drop', asset: 'USDC', asset_issuer: 'GI', total_amount: '100', expiry_ledger: 1000,
        contract_airdrop_id: '0xcontract',
      });
      expect(airdrop.contract_airdrop_id).toBe('0xcontract');
    });

    test('defaults contract_airdrop_id to null', async () => {
      const airdrop = await airdropsService.create({
        name: 'Drop', asset: 'USDC', asset_issuer: 'GI', total_amount: '100', expiry_ledger: 1000,
      });
      expect(airdrop.contract_airdrop_id).toBeNull();
    });
  });
});
