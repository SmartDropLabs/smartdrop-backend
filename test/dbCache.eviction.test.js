'use strict';

// Keep the tracked-key bound small so eviction is easy to exercise. Must be set
// before dbCache is required, because the bound is read at load time.
process.env.DB_CACHE_MAX_ENTRIES = '2';

jest.mock('../src/services/cache', () => ({
  del: jest.fn(async () => 1),
  fetchWithLock: jest.fn(async (key, fn) => fn()),
}));

jest.mock('../src/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const cache = require('../src/services/cache');
const dbCache = require('../src/services/dbCache');

describe('dbCache eviction (#700)', () => {
  beforeEach(() => {
    cache.del.mockClear();
  });

  test('evicts the least recently used entry once the bound is reached', async () => {
    const executor = jest.fn(async (q) => q);

    await dbCache.cachedQuery('SELECT 1', [], { executor });
    await dbCache.cachedQuery('SELECT 2', [], { executor });
    // Using SELECT 1 again makes SELECT 2 the least recently used.
    await dbCache.cachedQuery('SELECT 1', [], { executor });
    await dbCache.cachedQuery('SELECT 3', [], { executor });

    expect(cache.del).toHaveBeenCalledTimes(1);
    expect(cache.del).toHaveBeenCalledWith(dbCache.generateCacheKey('SELECT 2', []));
    expect(dbCache.getTrackedKeyCount()).toBe(2);
  });

  test('a failed eviction does not fail the query', async () => {
    cache.del.mockRejectedValueOnce(new Error('redis down'));
    const executor = jest.fn(async () => 'rows');

    await dbCache.cachedQuery('SELECT 4', [], { executor });
    await dbCache.cachedQuery('SELECT 5', [], { executor });
    const result = await dbCache.cachedQuery('SELECT 6', [], { executor });

    expect(result).toBe('rows');
  });
});
