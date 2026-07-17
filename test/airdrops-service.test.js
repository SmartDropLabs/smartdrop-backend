'use strict';

const mockStore = new Map();
const mockSets = new Map();
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

const mockRedis = {
  smembers: jest.fn(async (key) => [...(mockSets.get(key) || [])]),
  sadd: jest.fn(async (key, val) => {
    if (!mockSets.has(key)) mockSets.set(key, new Set());
    mockSets.get(key).add(val);
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
    test('pages through every ID in the set across multiple SSCAN batches', async () => {
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
      // Confirms it actually paged (more than one SSCAN call for 5 items at
      // batch size 2), not just a single SMEMBERS-style dump.
      expect(mockRedis.sscan.mock.calls.length).toBeGreaterThan(1);
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
});
