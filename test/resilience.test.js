'use strict';

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const mockCacheGet = jest.fn();
const mockCacheSet = jest.fn();
const mockIsConnected = jest.fn();

jest.mock('../src/services/cache', () => ({
  get: mockCacheGet,
  set: mockCacheSet,
  del: jest.fn(),
  getClient: jest.fn(() => ({ scan: jest.fn(async () => ['0', []]) })),
  isConnected: mockIsConnected,
}));

const mockStellarFetch = jest.fn();
const mockCoingeckoFetch = jest.fn();
const mockCmcFetch = jest.fn();

jest.mock('../src/services/sources/stellarDex', () => ({ fetchPrice: mockStellarFetch }));
jest.mock('../src/services/sources/coingecko', () => ({ fetchPrice: mockCoingeckoFetch }));
jest.mock('../src/services/sources/coinmarketcap', () => ({ fetchPrice: mockCmcFetch }));

const logger = require('../src/logger');
const priceOracle = require('../src/services/priceOracle');

beforeEach(() => {
  mockCacheGet.mockReset();
  mockCacheSet.mockReset();
  mockIsConnected.mockReset();
  mockStellarFetch.mockReset();
  mockCoingeckoFetch.mockReset();
  mockCmcFetch.mockReset();
  logger.warn.mockClear();
  logger.error.mockClear();

  // Default: sources return a price
  mockStellarFetch.mockResolvedValue(0.10);
  mockCoingeckoFetch.mockResolvedValue(null);
  mockCmcFetch.mockResolvedValue(null);
});

describe('cache.get failure — falls back to source fetch', () => {
  test('returns price data when cache.get throws', async () => {
    mockCacheGet.mockRejectedValue(new Error('ECONNREFUSED'));
    mockCacheSet.mockResolvedValue(undefined);

    const result = await priceOracle.getPrice('XLM');

    expect(result.price_usd).toBe(0.10);
    expect(result.redis_unavailable).toBe(true);
  });

  test('sets redis_unavailable: true on cache.get error', async () => {
    mockCacheGet.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await priceOracle.getPrice('XLM');

    expect(result.redis_unavailable).toBe(true);
  });

  test('logs a warning (not an error) on cache.get failure', async () => {
    mockCacheGet.mockRejectedValue(new Error('Stream not writeable'));

    await priceOracle.getPrice('XLM');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Cache read failed'),
      expect.objectContaining({ error: 'Stream not writeable' })
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('does not throw — no unhandled rejection', async () => {
    mockCacheGet.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(priceOracle.getPrice('XLM')).resolves.toBeDefined();
  });
});

describe('cache.set failure — logs warning, returns price anyway', () => {
  test('returns price data when cache.set throws', async () => {
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await priceOracle.getPrice('XLM');

    expect(result.price_usd).toBe(0.10);
    expect(result.redis_unavailable).toBe(true);
  });

  test('logs a warning on cache.set failure', async () => {
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet.mockRejectedValue(new Error('offline queue full'));

    await priceOracle.getPrice('XLM');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Cache write failed'),
      expect.objectContaining({ error: 'offline queue full' })
    );
  });

  test('does not throw when cache.set fails', async () => {
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(priceOracle.getPrice('XLM')).resolves.toBeDefined();
  });
});

describe('cache working normally', () => {
  test('returns cached price with redis_unavailable: false', async () => {
    mockCacheGet.mockResolvedValue({
      price: 0.12,
      source: 'stellar_dex',
      fetchedAt: Date.now() - 30000,
      sourcesAttempted: ['stellar_dex'],
    });

    const result = await priceOracle.getPrice('XLM');

    expect(result.price_usd).toBe(0.12);
    expect(result.redis_unavailable).toBe(false);
    expect(mockStellarFetch).not.toHaveBeenCalled();
  });

  test('fetchFreshPrice sets redis_unavailable: false when cache.set succeeds', async () => {
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet.mockResolvedValue(undefined);

    const result = await priceOracle.fetchFreshPrice('XLM');

    expect(result.redis_unavailable).toBe(false);
  });
});

describe('all sources unavailable during Redis outage', () => {
  test('returns null price with redis_unavailable: true', async () => {
    mockCacheGet.mockRejectedValue(new Error('ECONNREFUSED'));
    mockStellarFetch.mockResolvedValue(null);
    mockCoingeckoFetch.mockResolvedValue(null);
    mockCmcFetch.mockResolvedValue(null);

    const result = await priceOracle.getPrice('XLM');

    expect(result.price_usd).toBeNull();
    expect(result.redis_unavailable).toBe(true);
    expect(result.is_stale).toBe(true);
  });
});

describe('refreshAllCachedPrices when Redis is down', () => {
  test('skips refresh cycle when isConnected returns false', async () => {
    mockIsConnected.mockReturnValue(false);

    await priceOracle.refreshAllCachedPrices();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Redis unavailable'));
    expect(mockStellarFetch).not.toHaveBeenCalled();
  });
});

describe('cache.isConnected', () => {
  test('cache module exports isConnected function', () => {
    const cache = require('../src/services/cache');
    expect(typeof cache.isConnected).toBe('function');
  });
});
