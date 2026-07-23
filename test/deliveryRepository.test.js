'use strict';

const { createCacheMock } = require('./helpers/cacheMock');

const mockHelper = createCacheMock();
const { reset, redis, zsets } = mockHelper;

jest.mock('../src/services/cache', () => mockHelper.cacheMock);
jest.mock('../src/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const deliveryRepo = require('../src/repositories/deliveryRepository');

const RETRY_QUEUE_KEY = 'webhooks:retries';

beforeEach(() => reset());

function seedDueRetries(count, { dueAt = 1000 } = {}) {
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const id = `dlv_${String(i).padStart(4, '0')}`;
    ids.push(id);
    redis.zadd(RETRY_QUEUE_KEY, dueAt + i, id);
  }
  return ids;
}

describe('popDueRetries', () => {
  test('returns and removes due ids up to max', async () => {
    seedDueRetries(5);
    const popped = await deliveryRepo.popDueRetries(2000, 3);
    expect(popped).toHaveLength(3);
    const remaining = zsets.get(RETRY_QUEUE_KEY);
    expect(remaining.size).toBe(2);
  });

  test('ignores retries not yet due', async () => {
    await deliveryRepo.scheduleRetry('dlv_future', 5000);
    const popped = await deliveryRepo.popDueRetries(1000, 25);
    expect(popped).toEqual([]);
    expect(zsets.get(RETRY_QUEUE_KEY).size).toBe(1);
  });

  test('empty due set returns [] without error', async () => {
    expect(await deliveryRepo.popDueRetries(Date.now(), 25)).toEqual([]);
  });

  test('two concurrent callers never receive overlapping ids', async () => {
    const seeded = seedDueRetries(50);
    const [first, second] = await Promise.all([
      deliveryRepo.popDueRetries(2000, 25),
      deliveryRepo.popDueRetries(2000, 25),
    ]);

    const overlap = first.filter((id) => second.includes(id));
    expect(overlap).toEqual([]);

    const union = new Set([...first, ...second]);
    expect(union.size).toBe(50);
    expect([...union].sort()).toEqual([...seeded].sort());
    expect(zsets.get(RETRY_QUEUE_KEY).size).toBe(0);
  });

  test('many concurrent callers still partition the queue with no duplicates', async () => {
    const seeded = seedDueRetries(100);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => deliveryRepo.popDueRetries(2000, 25)),
    );

    const allIds = results.flat();
    expect(allIds).toHaveLength(100);
    expect(new Set(allIds).size).toBe(100);
    expect([...allIds].sort()).toEqual([...seeded].sort());
  });

  test('regression: the old read-then-delete pattern double-claims under a race', async () => {
    // Demonstrates the bug this fix closes: two round trips to Redis (a
    // ZRANGEBYSCORE followed later by a ZREM) let a second caller read the
    // same ids before the first caller's ZREM has run. The production code
    // no longer does this - popDueRetries now uses a single atomic Lua
    // round trip - but this test proves the failure mode it replaces.
    seedDueRetries(10);

    async function racyPop(nowMs, max) {
      const ids = await redis.zrangebyscore(RETRY_QUEUE_KEY, '-inf', nowMs, 'LIMIT', 0, max);
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (ids.length > 0) await redis.zrem(RETRY_QUEUE_KEY, ...ids);
      return ids;
    }

    const [first, second] = await Promise.all([racyPop(2000, 10), racyPop(2000, 10)]);
    const overlap = first.filter((id) => second.includes(id));
    expect(overlap.length).toBeGreaterThan(0);
  });
});

describe('cancelRetry / scheduleRetry / listByWebhook (unchanged by the atomic fix)', () => {
  test('scheduleRetry adds a member with the given score', async () => {
    await deliveryRepo.scheduleRetry('dlv_a', 12345);
    expect(zsets.get(RETRY_QUEUE_KEY).get('dlv_a')).toBe(12345);
  });

  test('cancelRetry removes a scheduled retry', async () => {
    await deliveryRepo.scheduleRetry('dlv_b', 12345);
    await deliveryRepo.cancelRetry('dlv_b');
    expect(zsets.get(RETRY_QUEUE_KEY).has('dlv_b')).toBe(false);
  });

  test('listByWebhook returns all persisted deliveries for that webhook', async () => {
    const a = await deliveryRepo.create({ webhook_id: 'wh_1', event_id: 'evt_a', event_type: 'x' });
    const b = await deliveryRepo.create({ webhook_id: 'wh_1', event_id: 'evt_b', event_type: 'x' });
    const list = await deliveryRepo.listByWebhook('wh_1', 10);
    expect(list.map((d) => d.id).sort()).toEqual([a.id, b.id].sort());
  });
});
