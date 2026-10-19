'use strict';

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../src/config', () => ({
  redis: { url: 'redis://localhost:6379' },
}));

jest.mock('ioredis', () => jest.fn(() => ({
  commandQueue: [],
  status: 'ready',
  on: jest.fn(),
  connect: jest.fn().mockResolvedValue(undefined),
  get: jest.fn().mockResolvedValue(null),
  mget: jest.fn().mockResolvedValue([]),
  set: jest.fn().mockResolvedValue('OK'),
  setex: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  quit: jest.fn().mockResolvedValue('OK'),
})));

jest.mock('../src/logger', () => mockLogger);

function loadCache() {
  jest.resetModules();
  Object.values(mockLogger).forEach((fn) => fn.mockClear());
  const cache = require('../src/services/cache');
  const redis = cache.getClient();
  return { cache, redis };
}

describe('Redis queue warning state', () => {
  test('tracks warning suppression independently for each caller', async () => {
    const { cache, redis } = loadCache();
    redis.commandQueue.length = 101;

    await cache.get('missing');
    await cache.set('key', 'value');

    expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn.mock.calls.map(([, metadata]) => metadata.caller)).toEqual(['get', 'set']);

    await cache.get('missing-2');
    await cache.get('missing-3');
    await cache.get('missing-4');
    await cache.get('missing-5');

    expect(mockLogger.warn).toHaveBeenCalledTimes(2);
  });

  test('tracks critical warnings and recovery independently for each caller', async () => {
    const { cache, redis } = loadCache();
    redis.commandQueue.length = 501;

    await cache.get('missing');
    await cache.set('key', 'value');

    expect(mockLogger.error).toHaveBeenCalledTimes(2);
    expect(mockLogger.error.mock.calls.map(([, metadata]) => metadata.caller)).toEqual(['get', 'set']);

    redis.commandQueue.length = 0;
    await cache.get('missing-2');
    await cache.set('key-2', 'value-2');

    expect(mockLogger.info).toHaveBeenCalledTimes(2);
    expect(mockLogger.info.mock.calls.map(([, metadata]) => metadata.caller)).toEqual(['get', 'set']);
  });
});

// Issue #366: getClient() returned a cached client with no check that it
// was still usable, so a client that had reached ioredis's terminal 'end'
// state (no auto-reconnect, every command rejected immediately) would keep
// being handed to every caller forever.
describe('getClient health check (#366)', () => {
  test('returns the same client instance while it is healthy', () => {
    const { cache, redis } = loadCache();
    const again = cache.getClient();
    expect(again).toBe(redis);
  });

  test('discards a client in the terminal "end" state and creates a fresh one', () => {
    const { cache, redis } = loadCache();
    redis.status = 'end';

    const next = cache.getClient();

    expect(next).not.toBe(redis);
    expect(next.status).toBe('ready');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('terminal "end" state'),
      expect.any(Object),
    );
  });

  test('does not discard a client that is merely reconnecting (offline queue covers it)', () => {
    const { cache, redis } = loadCache();
    redis.status = 'reconnecting';

    const next = cache.getClient();

    expect(next).toBe(redis);
  });
});

// Issue #357: repository hot paths that hydrate a whole page of ids used to
// pay one round trip per key; mget() collapses them into a single MGET.
describe('mget batched reads (#357)', () => {
  test('returns parsed values in key order, with null for misses', async () => {
    const { cache, redis } = loadCache();
    redis.mget.mockResolvedValue([JSON.stringify({ id: 'a' }), null, JSON.stringify({ id: 'c' })]);

    expect(await cache.mget(['ka', 'kb', 'kc'])).toEqual([{ id: 'a' }, null, { id: 'c' }]);
    expect(redis.mget).toHaveBeenCalledWith('ka', 'kb', 'kc');
    expect(redis.get).not.toHaveBeenCalled();
  });

  test('an empty key list never reaches Redis', async () => {
    const { cache, redis } = loadCache();

    expect(await cache.mget([])).toEqual([]);
    expect(await cache.mget(undefined)).toEqual([]);
    expect(redis.mget).not.toHaveBeenCalled();
  });

  test('a corrupt value is reported as a cache miss, exactly like get()', async () => {
    const { cache, redis } = loadCache();
    redis.mget.mockResolvedValue(['not-json']);

    expect(await cache.mget(['bad'])).toEqual([null]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Cached value failed JSON.parse, treating as a cache miss',
      expect.objectContaining({ key: 'bad' }),
    );
  });

  test('a failing MGET rejects so callers keep their own error handling', async () => {
    const { cache, redis } = loadCache();
    redis.mget.mockRejectedValue(new Error('connection refused'));

    await expect(cache.mget(['k'])).rejects.toThrow('connection refused');
  });
});
