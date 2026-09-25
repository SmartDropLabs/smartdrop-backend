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
