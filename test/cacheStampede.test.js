'use strict';

const {
  SingleFlight,
  acquireLock,
  releaseLock,
  fetchWithLock,
} = require('../src/cache/stampede');
const { cachedQuery } = require('../src/services/dbCache');
const cache = require('../src/services/cache');

// Mock cache
const mockStore = new Map();
const mockLockStore = new Map();

jest.mock('../src/services/cache', () => ({
  get: jest.fn(async (key) => mockStore.get(key) || null),
  set: jest.fn(async (key, value, ttl) => {
    mockStore.set(key, value);
  }),
  del: jest.fn(async (key) => {
    mockStore.delete(key);
  }),
  getClient: jest.fn(() => ({
    set: jest.fn(async (key, val, px, ttl, nx) => {
      if (nx === 'NX') {
        if (mockLockStore.has(key)) return null;
        mockLockStore.set(key, val);
        return 'OK';
      }
      mockLockStore.set(key, val);
      return 'OK';
    }),
    get: jest.fn(async (key) => mockLockStore.get(key) || null),
    del: jest.fn(async (key) => {
      const existed = mockLockStore.delete(key);
      return existed ? 1 : 0;
    }),
    eval: jest.fn(async (script, numKeys, key, token) => {
      if (mockLockStore.get(key) === token) {
        mockLockStore.delete(key);
        return 1;
      }
      return 0;
    }),
  })),
}));

jest.mock('../src/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('Cache Stampede Protection (#518)', () => {
  beforeEach(() => {
    mockStore.clear();
    mockLockStore.clear();
    jest.clearAllMocks();
  });

  describe('SingleFlight', () => {
    test('coalesces multiple simultaneous calls for the same key into a single invocation', async () => {
      const sf = new SingleFlight();
      let callCount = 0;

      const slowFn = async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 50));
        return 'data-123';
      };

      const results = await Promise.all([
        sf.do('key-1', slowFn),
        sf.do('key-1', slowFn),
        sf.do('key-1', slowFn),
      ]);

      expect(callCount).toBe(1);
      expect(results).toEqual(['data-123', 'data-123', 'data-123']);
      expect(sf.size).toBe(0);
    });

    test('executes again after previous promise completes', async () => {
      const sf = new SingleFlight();
      let callCount = 0;
      const fn = async () => {
        callCount++;
        return `call-${callCount}`;
      };

      const res1 = await sf.do('key-1', fn);
      const res2 = await sf.do('key-1', fn);

      expect(callCount).toBe(2);
      expect(res1).toBe('call-1');
      expect(res2).toBe('call-2');
    });

    test('cleans up key and propagates error when fn throws', async () => {
      const sf = new SingleFlight();
      const failingFn = async () => {
        throw new Error('fetch error');
      };

      await expect(sf.do('err-key', failingFn)).rejects.toThrow('fetch error');
      expect(sf.has('err-key')).toBe(false);
    });
  });

  describe('acquireLock & releaseLock', () => {
    test('acquires lock and releases with matching token', async () => {
      const token = await acquireLock('test-key', { lockTtlMs: 1000 });
      expect(token).toBeTruthy();

      // Second acquire fails
      const secondToken = await acquireLock('test-key', { lockTtlMs: 1000 });
      expect(secondToken).toBeNull();

      // Release with token succeeds
      const released = await releaseLock('test-key', token);
      expect(released).toBe(true);

      // Now can acquire again
      const thirdToken = await acquireLock('test-key', { lockTtlMs: 1000 });
      expect(thirdToken).toBeTruthy();
    });

    test('releaseLock fails if wrong token is provided', async () => {
      const token = await acquireLock('protected-key', { lockTtlMs: 1000 });
      const released = await releaseLock('protected-key', 'wrong-token');
      expect(released).toBe(false);
    });
  });

  describe('fetchWithLock', () => {
    test('returns cached value without calling fetcher if cache hits', async () => {
      mockStore.set('cache:hit', JSON.stringify({ name: 'Alice' }));
      const fetcher = jest.fn();

      const result = await fetchWithLock('cache:hit', fetcher);
      expect(result).toEqual({ name: 'Alice' });
      expect(fetcher).not.toHaveBeenCalled();
    });

    test('prevents cache stampede: concurrent calls invoke fetcher only once', async () => {
      let executions = 0;
      const slowFetcher = async () => {
        executions++;
        await new Promise((r) => setTimeout(r, 60));
        return { count: executions, data: 'loaded from db' };
      };

      // 10 concurrent requests for the same missing key
      const results = await Promise.all([
        fetchWithLock('stampede:key', slowFetcher),
        fetchWithLock('stampede:key', slowFetcher),
        fetchWithLock('stampede:key', slowFetcher),
        fetchWithLock('stampede:key', slowFetcher),
        fetchWithLock('stampede:key', slowFetcher),
      ]);

      expect(executions).toBe(1);
      results.forEach((res) => {
        expect(res).toEqual({ count: 1, data: 'loaded from db' });
      });

      // Subsequent call gets value from cache
      const nextResult = await fetchWithLock('stampede:key', slowFetcher);
      expect(executions).toBe(1);
      expect(nextResult).toEqual({ count: 1, data: 'loaded from db' });
    });

    test('skipCache executes fetcher directly without caching', async () => {
      const fetcher = jest.fn(async () => 'fresh-value');
      const res = await fetchWithLock('skip:key', fetcher, { skipCache: true });
      expect(res).toBe('fresh-value');
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test('backgroundRefresh serves stale data and asynchronously updates cache', async () => {
      // Setup expired cache with metadata
      mockStore.set('stale:key', JSON.stringify({
        __stampede_meta: true,
        value: 'old-stale-value',
        expiresAt: Date.now() - 5000, // already expired
      }));

      let fetcherCalls = 0;
      const fetcher = jest.fn(async () => {
        fetcherCalls++;
        return 'newly-refreshed-value';
      });

      const res = await fetchWithLock('stale:key', fetcher, {
        backgroundRefresh: true,
        ttlSeconds: 30,
      });

      // Immediately returned stale value
      expect(res).toBe('old-stale-value');

      // Wait a tick for background setImmediate to run
      await new Promise((r) => setTimeout(r, 50));
      expect(fetcher).toHaveBeenCalled();
    });
  });

  describe('cachedQuery integration', () => {
    test('coalesces identical simultaneous SQL queries through dbCache', async () => {
      let dbExecutions = 0;
      const mockExecutor = jest.fn(async (sql, params) => {
        dbExecutions++;
        await new Promise((r) => setTimeout(r, 50));
        return [{ id: params[0], name: 'SmartDrop' }];
      });

      const query = 'SELECT * FROM drops WHERE id = $1';
      const params = [42];

      const results = await Promise.all([
        cachedQuery(query, params, { executor: mockExecutor }),
        cachedQuery(query, params, { executor: mockExecutor }),
        cachedQuery(query, params, { executor: mockExecutor }),
      ]);

      expect(dbExecutions).toBe(1);
      results.forEach((res) => {
        expect(res).toEqual([{ id: 42, name: 'SmartDrop' }]);
      });
    });
  });
});
