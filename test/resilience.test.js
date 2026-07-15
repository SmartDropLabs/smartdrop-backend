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
  logger.info.mockClear();
  logger.error.mockClear();
  priceOracle.resetPriceSourceCircuitStates();

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

describe('price source non-retryable circuit breaker', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    mockCacheSet.mockResolvedValue(undefined);
    mockStellarFetch.mockResolvedValue(null);
    mockCoingeckoFetch.mockResolvedValue(null);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function authError() {
    const err = new Error('bad api key');
    err.nonRetryable = true;
    err.response = { status: 401 };
    return err;
  }

  function cmcCircuitState() {
    return priceOracle
      .getPriceSourceCircuitStates()
      .find((state) => state.source === 'coinmarketcap');
  }

  test('opens the circuit on a non-retryable CoinMarketCap failure and skips while open', async () => {
    mockCmcFetch.mockRejectedValueOnce(authError());

    const firstResult = await priceOracle.fetchFreshPrice('XLM');

    expect(firstResult.price_usd).toBeNull();
    expect(mockCmcFetch).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Price source permanently misconfigured',
      expect.objectContaining({
        source: 'coinmarketcap',
        assetCode: 'XLM',
        error: 'bad api key',
        status_code: 401,
        cooldown_ms: 900000,
        open_until: '2026-01-01T00:15:00.000Z',
      })
    );
    expect(cmcCircuitState()).toEqual(
      expect.objectContaining({
        open: true,
        opened_at: '2026-01-01T00:00:00.000Z',
        open_until: '2026-01-01T00:15:00.000Z',
        last_error: 'bad api key',
        status_code: 401,
      })
    );

    mockCmcFetch.mockClear();
    logger.error.mockClear();
    logger.warn.mockClear();

    const skippedResult = await priceOracle.fetchFreshPrice('XLM');

    expect(skippedResult.price_usd).toBeNull();
    expect(mockCmcFetch).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalledWith(
      'Price source circuit open, skipping fetch',
      expect.any(Object)
    );
  });

  test('retries after cooldown and closes the circuit after a successful fetch', async () => {
    mockCmcFetch.mockRejectedValueOnce(authError());
    await priceOracle.fetchFreshPrice('XLM');

    mockCmcFetch.mockClear();
    logger.info.mockClear();

    jest.advanceTimersByTime(900000 - 1);
    await priceOracle.fetchFreshPrice('XLM');
    expect(mockCmcFetch).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    mockCmcFetch.mockResolvedValueOnce(0.1234);

    const result = await priceOracle.fetchFreshPrice('XLM');

    expect(result.price_usd).toBe(0.1234);
    expect(mockCmcFetch).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('Price source circuit closed', {
      source: 'coinmarketcap',
      assetCode: 'XLM',
    });
    expect(cmcCircuitState()).toEqual(
      expect.objectContaining({
        open: false,
        opened_at: null,
        open_until: null,
        last_error: null,
        status_code: null,
      })
    );
  });

  test('leaves ordinary retryable source failures on the existing per-cycle path', async () => {
    mockCmcFetch.mockRejectedValueOnce(new Error('temporary timeout')).mockResolvedValueOnce(0.2);

    await priceOracle.fetchFreshPrice('XLM');
    await priceOracle.fetchFreshPrice('XLM');

    expect(mockCmcFetch).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      'Source fetch failed',
      expect.objectContaining({
        source: 'coinmarketcap',
        assetCode: 'XLM',
        error: 'temporary timeout',
      })
    );
    expect(logger.error).not.toHaveBeenCalledWith(
      'Price source permanently misconfigured',
      expect.any(Object)
    );
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
