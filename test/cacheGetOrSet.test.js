'use strict';

// #614 — cache.getOrSet is the stampede-protected read-through path: a miss
// is routed through stampede.fetchWithLock instead of a bare get/fetch/set.

jest.mock('../src/config', () => ({
  redis: { url: 'redis://localhost:6379' },
}));
jest.mock('ioredis', () => jest.fn(() => ({
  commandQueue: [],
  status: 'ready',
  on: jest.fn(),
  connect: jest.fn().mockResolvedValue(undefined),
})));
jest.mock('../src/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const mockFetchWithLock = jest.fn();
jest.mock('../src/cache/stampede', () => ({
  fetchWithLock: (...args) => mockFetchWithLock(...args),
}));

const cache = require('../src/services/cache');

beforeEach(() => mockFetchWithLock.mockReset());

test('routes the read through fetchWithLock with the given TTL', async () => {
  mockFetchWithLock.mockResolvedValue({ price: 1 });
  const fetchFn = jest.fn();

  const value = await cache.getOrSet('price:xlm', fetchFn, 30);

  expect(value).toEqual({ price: 1 });
  expect(mockFetchWithLock).toHaveBeenCalledWith('price:xlm', fetchFn, { ttlSeconds: 30 });
});

test('defaults the TTL to 60s and passes other options through', async () => {
  mockFetchWithLock.mockResolvedValue('v');
  const fetchFn = jest.fn();

  await cache.getOrSet('k', fetchFn, undefined, { backgroundRefresh: true });

  expect(mockFetchWithLock).toHaveBeenCalledWith('k', fetchFn, {
    backgroundRefresh: true,
    ttlSeconds: 60,
  });
});
