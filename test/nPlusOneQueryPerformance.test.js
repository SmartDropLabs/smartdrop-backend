'use strict';

const cache = require('../src/services/cache');
const apiKeys = require('../src/services/apiKeys');
const alertsService = require('../src/services/alerts');
const airdropsService = require('../src/services/airdrops');
const webhookRepository = require('../src/repositories/webhookRepository');

describe('Issue #458: Constant Query Counts Across Endpoints (No N+1 Queries)', () => {
  let mockStore;
  let queryCount;
  let mockRedis;

  beforeEach(() => {
    mockStore = new Map();
    queryCount = 0;

    mockRedis = {
      zrevrange: jest.fn(async (key, start, end) => {
        queryCount++;
        const sorted = mockStore.get(key) || [];
        const limit = end === -1 ? undefined : (end - start + 1);
        return sorted.slice(start, limit ? start + limit : undefined);
      }),
      zcard: jest.fn(async (key) => {
        queryCount++;
        return (mockStore.get(key) || []).length;
      }),
      smembers: jest.fn(async (key) => {
        queryCount++;
        return mockStore.get(key) || [];
      }),
      get: jest.fn(async (key) => {
        queryCount++;
        const val = mockStore.get(key);
        return val !== undefined ? JSON.stringify(val) : null;
      }),
      mget: jest.fn(async (...keys) => {
        queryCount++;
        return keys.map((k) => {
          const val = mockStore.get(k);
          return val !== undefined ? JSON.stringify(val) : null;
        });
      }),
    };

    jest.spyOn(cache, 'getClient').mockReturnValue(mockRedis);
    jest.spyOn(cache, 'get').mockImplementation(async (key) => {
      const raw = await mockRedis.get(key);
      return raw ? JSON.parse(raw) : null;
    });
    jest.spyOn(cache, 'mget').mockImplementation(async (keys) => {
      const raw = await mockRedis.mget(...keys);
      return raw.map((r) => (r ? JSON.parse(r) : null));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function populateKeys(count) {
    const ids = [];
    for (let i = 0; i < count; i++) {
      const id = `key_${i}`;
      ids.push(id);
      mockStore.set(`api_key:${id}`, { id, label: `key-${i}`, key_hash: `hash_${i}` });
    }
    mockStore.set('api_keys', ids);
  }

  function populateAlerts(count) {
    const ids = [];
    for (let i = 0; i < count; i++) {
      const id = `alrt_${i}`;
      ids.push(id);
      mockStore.set(`alert:${id}`, { id, asset: 'XLM', threshold_usd: 0.5 });
    }
    mockStore.set('alerts:ids', ids);
  }

  function populateAirdrops(count) {
    const ids = [];
    for (let i = 0; i < count; i++) {
      const id = `drop_${i}`;
      ids.push(id);
      mockStore.set(`airdrop:${id}`, { id, name: `Airdrop ${i}`, total_amount: 1000 });
    }
    mockStore.set('airdrops:ids', ids);
  }

  function populateWebhooks(count) {
    const ids = [];
    for (let i = 0; i < count; i++) {
      const id = `wh_${i}`;
      ids.push(id);
      mockStore.set(`webhook:${id}`, { id, url: `https://example.com/hook/${i}`, events: ['price.updated'] });
    }
    mockStore.set('webhooks:ids', ids);
  }

  test('apiKeys.listKeys query count stays constant as row count grows (5 vs 50 rows)', async () => {
    populateKeys(5);
    queryCount = 0;
    const res5 = await apiKeys.listKeys();
    expect(res5).toHaveLength(5);
    const count5 = queryCount;
    expect(count5).toBe(2); // 1 zrevrange + 1 mget

    mockStore.clear();
    populateKeys(50);
    queryCount = 0;
    const res50 = await apiKeys.listKeys();
    expect(res50).toHaveLength(50);
    const count50 = queryCount;

    expect(count50).toBe(count5);
    expect(count50).toBe(2);
  });

  test('alertsService.listPaginated query count stays constant as row count grows (5 vs 50 rows)', async () => {
    populateAlerts(5);
    queryCount = 0;
    const res5 = await alertsService.listPaginated({ limit: 100 });
    expect(res5.alerts).toHaveLength(5);
    const count5 = queryCount;
    expect(count5).toBe(3); // 1 zcard + 1 zrevrange + 1 mget

    mockStore.clear();
    populateAlerts(50);
    queryCount = 0;
    const res50 = await alertsService.listPaginated({ limit: 100 });
    expect(res50.alerts).toHaveLength(50);
    const count50 = queryCount;

    expect(count50).toBe(count5);
    expect(count50).toBe(3);
  });

  test('airdropsService.list query count stays constant as row count grows (5 vs 50 rows)', async () => {
    populateAirdrops(5);
    queryCount = 0;
    const res5 = await airdropsService.list(1, 100);
    expect(res5.airdrops).toHaveLength(5);
    const count5 = queryCount;
    expect(count5).toBe(3); // 1 zcard + 1 zrevrange + 1 mget

    mockStore.clear();
    populateAirdrops(50);
    queryCount = 0;
    const res50 = await airdropsService.list(1, 100);
    expect(res50.airdrops).toHaveLength(50);
    const count50 = queryCount;

    expect(count50).toBe(count5);
    expect(count50).toBe(3);
  });

  test('webhookRepository.list query count stays constant as row count grows (5 vs 50 rows)', async () => {
    populateWebhooks(5);
    queryCount = 0;
    const res5 = await webhookRepository.list(1, 100);
    expect(res5.webhooks).toHaveLength(5);
    const count5 = queryCount;
    expect(count5).toBe(3); // 1 zcard + 1 zrevrange + 1 mget

    mockStore.clear();
    populateWebhooks(50);
    queryCount = 0;
    const res50 = await webhookRepository.list(1, 100);
    expect(res50.webhooks).toHaveLength(50);
    const count50 = queryCount;

    expect(count50).toBe(count5);
    expect(count50).toBe(3);
  });
});
