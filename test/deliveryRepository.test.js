'use strict';

const { createCacheMock } = require('./helpers/cacheMock');

const mockHelper = createCacheMock();
const { reset, redis, zsets } = mockHelper;

jest.mock('../src/services/cache', () => mockHelper.cacheMock);
jest.mock('../src/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const deliveryRepo = require('../src/repositories/deliveryRepository');
const cache = require('../src/services/cache');

const RETRY_QUEUE_KEY = 'webhooks:retries';
const WEBHOOK_ID = 'wh_1';

// create() refuses to log a delivery for a webhook that does not exist
// (#411), so every test in this file works against one seeded fixture
// webhook.
async function seedWebhook(id = WEBHOOK_ID) {
  await cache.set(`webhook:${id}`, {
    id,
    url: 'https://example.com/hook',
    events: ['*'],
    secret: 'whsec_aaaaaaaaaaaaaaaa',
    active: true,
    description: null,
    filters: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

beforeEach(async () => {
  reset();
  await seedWebhook();
});

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
    // cancelRetry verifies the delivery exists first (#371), so the record
    // has to be there before the queue entry is worth cancelling.
    const delivery = await deliveryRepo.create({
      webhook_id: WEBHOOK_ID,
      event_id: 'evt_cancel',
      event_type: 'x',
    });
    await deliveryRepo.scheduleRetry(delivery.id, 12345);
    await deliveryRepo.cancelRetry(delivery.id);
    expect(zsets.get(RETRY_QUEUE_KEY).has(delivery.id)).toBe(false);
  });

  test('listByWebhook returns all persisted deliveries for that webhook', async () => {
    const a = await deliveryRepo.create({ webhook_id: 'wh_1', event_id: 'evt_a', event_type: 'x' });
    const b = await deliveryRepo.create({ webhook_id: 'wh_1', event_id: 'evt_b', event_type: 'x' });
    const list = await deliveryRepo.listByWebhook('wh_1', 10);
    expect(list.map((d) => d.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe('countPendingRetries (issue #235)', () => {
  test('counts the whole retry queue, not only entries already due', async () => {
    await deliveryRepo.scheduleRetry('dlv_due', Date.now() - 1000);
    await deliveryRepo.scheduleRetry('dlv_later', Date.now() + 60_000);

    await expect(deliveryRepo.countPendingRetries()).resolves.toBe(2);
  });

  test('reports zero for an empty queue', async () => {
    await expect(deliveryRepo.countPendingRetries()).resolves.toBe(0);
  });

  test('returns null rather than zero when Redis cannot be read', async () => {
    redis.zcard.mockRejectedValueOnce(new Error('connection refused'));

    await expect(deliveryRepo.countPendingRetries()).resolves.toBeNull();
  });
});

describe('request_id propagation onto delivery records (issue #250)', () => {
  test('persists the originating request id when one is supplied', async () => {
    const delivery = await deliveryRepo.create({
      webhook_id: 'wh_1',
      event_id: 'evt_1',
      event_type: 'pool.assets_locked',
      request_id: 'req_abc123',
    });

    expect(delivery.request_id).toBe('req_abc123');
    await expect(deliveryRepo.findById(delivery.id))
      .resolves.toEqual(expect.objectContaining({ request_id: 'req_abc123' }));
  });

  test('stores null for deliveries originated by background jobs', async () => {
    const delivery = await deliveryRepo.create({
      webhook_id: 'wh_1',
      event_id: 'evt_2',
      event_type: 'pool.assets_locked',
    });

    expect(delivery.request_id).toBeNull();
  });
});

describe('atomic create (issue #358)', () => {
  const ALL_INDEX = `webhook:${WEBHOOK_ID}:deliveries`;
  const TTL = 30 * 24 * 60 * 60;

  function clearWriteMocks() {
    redis.multi.mockClear();
    redis.set.mockClear();
    redis.zadd.mockClear();
    redis.zremrangebyrank.mockClear();
    redis.expire.mockClear();
    cache.set.mockClear();
  }

  test('commits record, index insert, index trim and TTL in one MULTI/EXEC', async () => {
    clearWriteMocks();

    const delivery = await deliveryRepo.create({
      webhook_id: WEBHOOK_ID,
      event_id: 'evt_atomic',
      event_type: 'pool.assets_locked',
    });

    expect(redis.multi).toHaveBeenCalledTimes(1);
    // …and every write queued on that transaction actually landed, rather
    // than the transaction merely having been issued.
    expect(await deliveryRepo.findById(delivery.id))
      .toEqual(expect.objectContaining({ id: delivery.id, status: 'pending' }));
    expect(zsets.get(ALL_INDEX).has(delivery.id)).toBe(true);
    expect(zsets.get(`${ALL_INDEX}:pending`).has(delivery.id)).toBe(true);
    // Record and both index keys carry the same 30-day TTL…
    expect(redis.set).toHaveBeenCalledWith(`webhook_delivery:${delivery.id}`, expect.any(String), 'EX', TTL);
    expect(redis.expire).toHaveBeenCalledWith(ALL_INDEX, TTL);
    expect(redis.expire).toHaveBeenCalledWith(`${ALL_INDEX}:pending`, TTL);
    // …and the index is still trimmed back to the 100 newest entries.
    expect(redis.zremrangebyrank).toHaveBeenCalledWith(ALL_INDEX, 0, -101);
  });

  test('issues no write outside of the transaction', async () => {
    clearWriteMocks();

    await deliveryRepo.create({
      webhook_id: WEBHOOK_ID,
      event_id: 'evt_single_write',
      event_type: 'pool.assets_locked',
    });

    // cache.set is the old non-atomic write path — it must not be used, and
    // the raw commands must only ever be seen coming out of .exec().
    expect(cache.set).not.toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.zadd).toHaveBeenCalledTimes(2);
    expect(redis.expire).toHaveBeenCalledTimes(2);
  });
});

describe('status-indexed listing (issue #359)', () => {
  const ALL_INDEX = `webhook:${WEBHOOK_ID}:deliveries`;
  const statusIndex = (status) => `${ALL_INDEX}:${status}`;

  // Distinct creation timestamps, so newest-first ordering is observable.
  async function seedDeliveries(count = 3) {
    const ids = [];
    for (let i = 0; i < count; i += 1) {
      const delivery = await deliveryRepo.create({
        webhook_id: WEBHOOK_ID,
        event_id: `evt_${i}`,
        event_type: 'x',
      });
      ids.push(delivery.id);
      await new Promise((resolve) => { setTimeout(resolve, 3); });
    }
    return ids;
  }

  test('a status filter is answered from that status index alone', async () => {
    const ids = await seedDeliveries();
    await deliveryRepo.update(ids[1], { status: 'failed' });
    await deliveryRepo.update(ids[2], { status: 'success' });

    redis.zrevrange.mockClear();
    redis.mget.mockClear();

    const failed = await deliveryRepo.listByWebhook(WEBHOOK_ID, { limit: 10, status: 'failed' });

    expect(failed.map((d) => d.id)).toEqual([ids[1]]);
    // One read, on the status index — the unfiltered index is never opened.
    expect(redis.zrevrange).toHaveBeenCalledTimes(1);
    expect(redis.zrevrange).toHaveBeenCalledWith(statusIndex('failed'), 0, 9);
    // Only ids that can be returned are hydrated: one MGET for one key.
    expect(redis.mget).toHaveBeenCalledTimes(1);
    expect(redis.mget.mock.calls[0]).toHaveLength(1);
  });

  test('create puts the id in the status index for its initial status', async () => {
    const ids = await seedDeliveries();
    await deliveryRepo.update(ids[1], { status: 'success' });

    const pending = await deliveryRepo.listByWebhook(WEBHOOK_ID, { limit: 10, status: 'pending' });
    expect(pending.map((d) => d.id).sort()).toEqual([ids[0], ids[2]].sort());

    const success = await deliveryRepo.listByWebhook(WEBHOOK_ID, { limit: 10, status: 'success' });
    expect(success.map((d) => d.id)).toEqual([ids[1]]);
  });

  test('a status change moves the id between indexes in the same transaction', async () => {
    const ids = await seedDeliveries();
    redis.multi.mockClear();

    await deliveryRepo.update(ids[1], { status: 'failed' });

    expect(redis.multi).toHaveBeenCalledTimes(1);
    expect(zsets.get(statusIndex('pending')).has(ids[1])).toBe(false);
    expect(zsets.get(statusIndex('failed')).has(ids[1])).toBe(true);
    // The unfiltered recency index is untouched by a status transition.
    expect(zsets.get(ALL_INDEX).has(ids[1])).toBe(true);
    // Record and index agree on the new status…
    expect((await deliveryRepo.findById(ids[1])).status).toBe('failed');
    // …and the moved id keeps its creation timestamp as the score, so
    // ordering within a status index still matches the recency index.
    const stored = await deliveryRepo.findById(ids[1]);
    expect(zsets.get(statusIndex('failed')).get(ids[1])).toBe(Date.parse(stored.created_at));
  });

  test('an unfiltered listing reads only `limit` ids from the recency index', async () => {
    const ids = await seedDeliveries();
    redis.zrevrange.mockClear();

    const page = await deliveryRepo.listByWebhook(WEBHOOK_ID, 2);

    expect(page.map((d) => d.id)).toEqual([ids[2], ids[1]]);
    expect(redis.zrevrange).toHaveBeenCalledTimes(1);
    expect(redis.zrevrange).toHaveBeenCalledWith(ALL_INDEX, 0, 1);
  });

  test('a zero limit reads nothing from Redis', async () => {
    redis.zrevrange.mockClear();

    await expect(deliveryRepo.listByWebhook(WEBHOOK_ID, 0)).resolves.toEqual([]);
    expect(redis.zrevrange).not.toHaveBeenCalled();
  });

  test('an unknown status reads an empty index and returns []', async () => {
    redis.mget.mockClear();

    await expect(
      deliveryRepo.listByWebhook(WEBHOOK_ID, { limit: 10, status: 'failed' }),
    ).resolves.toEqual([]);
    expect(redis.mget).not.toHaveBeenCalled();
  });
});
