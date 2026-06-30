'use strict';

// Unit tests for the price oracle's core business logic: median aggregation,
// temporal anomaly detection, multi-source fan-out, and the cache hit/miss
// paths of getPrice/fetchFreshPrice/refreshAllCachedPrices.
//
// NOTE ON BEHAVIOUR: detectAnomaly compares the current aggregated price
// against the *previously cached aggregate over time* and only logs a warning.
// It does NOT exclude an outlier source from the median, and fetchFreshPrice
// ignores its return value. These tests document that actual behaviour rather
// than an assumed cross-source outlier-rejection scheme.

const mockCacheGet = jest.fn();
const mockCacheSet = jest.fn();
const mockCacheIsConnected = jest.fn();
const mockCacheGetClient = jest.fn();

const mockStellarFetch = jest.fn();
const mockCoingeckoFetch = jest.fn();
const mockCoinmarketcapFetch = jest.fn();

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../src/services/cache', () => ({
  get: mockCacheGet,
  set: mockCacheSet,
  isConnected: mockCacheIsConnected,
  getClient: mockCacheGetClient,
}));

jest.mock('../src/services/sources/stellarDex', () => ({ fetchPrice: mockStellarFetch }));
jest.mock('../src/services/sources/coingecko', () => ({ fetchPrice: mockCoingeckoFetch }));
jest.mock('../src/services/sources/coinmarketcap', () => ({ fetchPrice: mockCoinmarketcapFetch }));

jest.mock('../src/config', () => ({
  price: {
    cacheTtl: 60,
    refreshInterval: 30,
    staleThresholdMinutes: 5,
    anomalyThresholdPercent: 20,
  },
}));

jest.mock('../src/logger', () => mockLogger);

const oracle = require('../src/services/priceOracle');

beforeEach(() => {
  mockCacheGet.mockReset();
  mockCacheSet.mockReset();
  mockCacheIsConnected.mockReset();
  mockCacheGetClient.mockReset();
  mockStellarFetch.mockReset();
  mockCoingeckoFetch.mockReset();
  mockCoinmarketcapFetch.mockReset();
  Object.values(mockLogger).forEach((fn) => fn.mockClear());

  // Sensible defaults: cache writes succeed, cache empty unless a test says otherwise.
  mockCacheGet.mockResolvedValue(null);
  mockCacheSet.mockResolvedValue(undefined);
});

describe('median', () => {
  const { median } = oracle;

  test('returns null for an empty array', () => {
    expect(median([])).toBeNull();
  });

  test('returns the single value for a one-element array', () => {
    expect(median([5])).toBe(5);
  });

  test('averages the middle two for an even-length array', () => {
    expect(median([1, 3])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  test('returns the middle value for an odd-length array', () => {
    expect(median([1, 2, 3])).toBe(2);
  });

  test('does not mutate the input array (sorts a copy)', () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });

  test('sorts numerically, not lexicographically', () => {
    // Lexicographic sort would order these as [10, 100, 9] and return 100.
    expect(median([9, 10, 100])).toBe(10);
  });

  test('resists a single outlier print across three sources', () => {
    // The median is naturally robust to one bad print even though no source
    // is explicitly excluded.
    expect(median([1.0, 1.01, 50])).toBe(1.01);
  });
});

describe('detectAnomaly', () => {
  const { detectAnomaly } = oracle;
  const ASSET = 'XLM';

  test('stores the price and returns false when no history exists', async () => {
    mockCacheGet.mockResolvedValueOnce(null);

    const result = await detectAnomaly(0.1, ASSET, null);

    expect(result).toBe(false);
    expect(mockCacheSet).toHaveBeenCalledWith(
      'price:history:XLM',
      expect.objectContaining({ price: 0.1 }),
      3600
    );
  });

  test('treats a non-positive cached price as no history', async () => {
    mockCacheGet.mockResolvedValueOnce({ price: 0, timestamp: Date.now() });

    const result = await detectAnomaly(0.1, ASSET, null);

    expect(result).toBe(false);
    expect(mockCacheSet).toHaveBeenCalledWith(
      'price:history:XLM',
      expect.objectContaining({ price: 0.1 }),
      3600
    );
  });

  test('returns false for a change below the threshold', async () => {
    mockCacheGet.mockResolvedValueOnce({ price: 1.0, timestamp: Date.now() });

    const result = await detectAnomaly(1.1, ASSET, null); // +10%, threshold 20

    expect(result).toBe(false);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  test('returns false at exactly the threshold (strict greater-than boundary)', async () => {
    mockCacheGet.mockResolvedValueOnce({ price: 1.0, timestamp: Date.now() });

    const result = await detectAnomaly(1.2, ASSET, null); // exactly +20%

    expect(result).toBe(false);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  test('logs a warning and returns true just past the threshold', async () => {
    mockCacheGet.mockResolvedValueOnce({ price: 1.0, timestamp: Date.now() });

    const result = await detectAnomaly(1.21, ASSET, null); // +21%

    expect(result).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Price anomaly detected',
      expect.objectContaining({ assetCode: ASSET, previousPrice: 1.0, currentPrice: 1.21 })
    );
  });

  test('detects anomalies symmetrically on a downward move', async () => {
    mockCacheGet.mockResolvedValueOnce({ price: 1.0, timestamp: Date.now() });

    const result = await detectAnomaly(0.5, ASSET, null); // -50%

    expect(result).toBe(true);
  });

  test('re-stores the current price even when an anomaly fires', async () => {
    mockCacheGet.mockResolvedValueOnce({ price: 1.0, timestamp: Date.now() });

    await detectAnomaly(2.0, ASSET, null);

    expect(mockCacheSet).toHaveBeenCalledWith(
      'price:history:XLM',
      expect.objectContaining({ price: 2.0 }),
      3600
    );
  });

  test('uses an issuer-scoped history key when an issuer is provided', async () => {
    mockCacheGet.mockResolvedValueOnce(null);

    await detectAnomaly(1.0, 'USDC', 'GISSUER');

    expect(mockCacheGet).toHaveBeenCalledWith('price:history:USDC:GISSUER');
  });

  test('skips detection and returns false when the cache read fails', async () => {
    mockCacheGet.mockRejectedValueOnce(new Error('redis down'));

    const result = await detectAnomaly(1.0, ASSET, null);

    expect(result).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Cache read failed in anomaly detection, skipping',
      expect.objectContaining({ error: 'redis down' })
    );
    expect(mockCacheSet).not.toHaveBeenCalled();
  });

  test('swallows a cache write failure without throwing', async () => {
    mockCacheGet.mockResolvedValueOnce(null);
    mockCacheSet.mockRejectedValueOnce(new Error('write failed'));

    await expect(detectAnomaly(1.0, ASSET, null)).resolves.toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Cache write failed in anomaly detection',
      expect.objectContaining({ error: 'write failed' })
    );
  });
});

describe('fetchFromAllSources', () => {
  const { fetchFromAllSources } = oracle;

  test('returns a result entry for every source that succeeds', async () => {
    mockStellarFetch.mockResolvedValueOnce(0.1);
    mockCoingeckoFetch.mockResolvedValueOnce(0.11);
    mockCoinmarketcapFetch.mockResolvedValueOnce(0.12);

    const results = await fetchFromAllSources('XLM', null);

    expect(results).toEqual([
      { source: 'stellar_dex', price: 0.1 },
      { source: 'coingecko', price: 0.11 },
      { source: 'coinmarketcap', price: 0.12 },
    ]);
  });

  test('swallows a throwing source and returns the healthy ones', async () => {
    mockStellarFetch.mockResolvedValueOnce(0.1);
    mockCoingeckoFetch.mockRejectedValueOnce(new Error('timeout'));
    mockCoinmarketcapFetch.mockResolvedValueOnce(0.12);

    const results = await fetchFromAllSources('XLM', null);

    expect(results).toEqual([
      { source: 'stellar_dex', price: 0.1 },
      { source: 'coinmarketcap', price: 0.12 },
    ]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Source fetch failed',
      expect.objectContaining({ source: 'coingecko', error: 'timeout' })
    );
  });

  test('returns an empty array when every source throws', async () => {
    mockStellarFetch.mockRejectedValueOnce(new Error('a'));
    mockCoingeckoFetch.mockRejectedValueOnce(new Error('b'));
    mockCoinmarketcapFetch.mockRejectedValueOnce(new Error('c'));

    const results = await fetchFromAllSources('XLM', null);

    expect(results).toEqual([]);
  });

  test('ignores null and non-positive prices from sources', async () => {
    mockStellarFetch.mockResolvedValueOnce(null);
    mockCoingeckoFetch.mockResolvedValueOnce(0);
    mockCoinmarketcapFetch.mockResolvedValueOnce(0.12);

    const results = await fetchFromAllSources('XLM', null);

    expect(results).toEqual([{ source: 'coinmarketcap', price: 0.12 }]);
  });

  test('accepts a single healthy source (no minimum-quorum rule)', async () => {
    mockStellarFetch.mockResolvedValueOnce(0.1);
    mockCoingeckoFetch.mockResolvedValueOnce(null);
    mockCoinmarketcapFetch.mockRejectedValueOnce(new Error('down'));

    const results = await fetchFromAllSources('XLM', null);

    expect(results).toEqual([{ source: 'stellar_dex', price: 0.1 }]);
  });
});

describe('getPrice', () => {
  const { getPrice } = oracle;

  test('returns a fresh cached price with is_stale false on a cache hit', async () => {
    const fetchedAt = Date.now() - 60 * 1000; // 1 minute old, threshold 5
    mockCacheGet.mockResolvedValueOnce({
      price: 1.01,
      source: 'coingecko',
      fetchedAt,
      sourcesAttempted: ['stellar_dex', 'coingecko'],
    });

    const result = await getPrice('USDC', 'GISSUER');

    expect(result).toMatchObject({
      asset_code: 'USDC',
      issuer: 'GISSUER',
      price_usd: 1.01,
      source: 'coingecko',
      is_stale: false,
      stale_warning: null,
      sources_attempted: ['stellar_dex', 'coingecko'],
      redis_unavailable: false,
    });
    // Cache hit must not fan out to the sources.
    expect(mockStellarFetch).not.toHaveBeenCalled();
  });

  test('flags is_stale and emits a warning when the cached entry is old', async () => {
    const fetchedAt = Date.now() - 10 * 60 * 1000; // 10 minutes old, threshold 5
    mockCacheGet.mockResolvedValueOnce({
      price: 1.01,
      source: 'coingecko',
      fetchedAt,
      sourcesAttempted: ['coingecko'],
    });

    const result = await getPrice('USDC', null);

    expect(result.is_stale).toBe(true);
    expect(result.stale_warning).toMatch(/threshold: 5 min/);
  });

  test('defaults sources_attempted to an empty array when absent from the cache entry', async () => {
    mockCacheGet.mockResolvedValueOnce({
      price: 1.01,
      source: 'coingecko',
      fetchedAt: Date.now(),
    });

    const result = await getPrice('USDC', null);

    expect(result.sources_attempted).toEqual([]);
  });

  test('falls through to a fresh fetch and caches the result on a cache miss', async () => {
    mockCacheGet.mockResolvedValueOnce(null); // miss
    mockStellarFetch.mockResolvedValueOnce(0.1);
    mockCoingeckoFetch.mockResolvedValueOnce(0.12);
    mockCoinmarketcapFetch.mockResolvedValueOnce(0.11);

    const result = await getPrice('XLM', null);

    // median([0.1, 0.12, 0.11]) === 0.11
    expect(result.price_usd).toBe(0.11);
    expect(result.is_stale).toBe(false);
    expect(result.sources_attempted).toEqual(['stellar_dex', 'coingecko', 'coinmarketcap']);
    // Result is written back to the main cache key.
    expect(mockCacheSet).toHaveBeenCalledWith(
      'price:XLM',
      expect.objectContaining({ price: 0.11, source: 'stellar_dex' }),
      60
    );
  });

  test('marks redis_unavailable and still fetches when the cache read throws', async () => {
    mockCacheGet.mockRejectedValueOnce(new Error('redis down'));
    mockStellarFetch.mockResolvedValueOnce(0.1);
    mockCoingeckoFetch.mockResolvedValueOnce(0.1);
    mockCoinmarketcapFetch.mockResolvedValueOnce(0.1);

    const result = await getPrice('XLM', null);

    expect(result.redis_unavailable).toBe(true);
    expect(result.price_usd).toBe(0.1);
    // When redis is unavailable we must not attempt to write back.
    expect(mockCacheSet).not.toHaveBeenCalled();
  });
});

describe('fetchFreshPrice', () => {
  const { fetchFreshPrice } = oracle;

  test('returns the unavailable shape when no source has data', async () => {
    mockStellarFetch.mockResolvedValueOnce(null);
    mockCoingeckoFetch.mockRejectedValueOnce(new Error('down'));
    mockCoinmarketcapFetch.mockResolvedValueOnce(null);

    const result = await fetchFreshPrice('XLM', null);

    expect(result).toMatchObject({
      price_usd: null,
      source: 'unavailable',
      is_stale: true,
      stale_warning: 'No price data available from any source',
    });
    expect(mockCacheSet).not.toHaveBeenCalled();
  });

  test('runs anomaly detection against the aggregated price when redis is available', async () => {
    // No price history yet -> detectAnomaly stores the aggregate and the main key.
    mockCacheGet.mockResolvedValue(null);
    mockStellarFetch.mockResolvedValueOnce(1.0);
    mockCoingeckoFetch.mockResolvedValueOnce(1.0);
    mockCoinmarketcapFetch.mockResolvedValueOnce(1.0);

    await fetchFreshPrice('USDC', null);

    expect(mockCacheSet).toHaveBeenCalledWith(
      'price:history:USDC',
      expect.objectContaining({ price: 1.0 }),
      3600
    );
  });

  test('skips anomaly detection and cache writes when redisUnavailable is true', async () => {
    mockStellarFetch.mockResolvedValueOnce(1.0);
    mockCoingeckoFetch.mockResolvedValueOnce(1.0);
    mockCoinmarketcapFetch.mockResolvedValueOnce(1.0);

    const result = await fetchFreshPrice('USDC', null, true);

    expect(result.redis_unavailable).toBe(true);
    expect(mockCacheSet).not.toHaveBeenCalled();
    expect(mockCacheGet).not.toHaveBeenCalled();
  });

  test('degrades to redis_unavailable when the cache write fails', async () => {
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet
      .mockResolvedValueOnce(undefined) // detectAnomaly history write succeeds
      .mockRejectedValueOnce(new Error('write failed')); // main cache write fails
    mockStellarFetch.mockResolvedValueOnce(1.0);
    mockCoingeckoFetch.mockResolvedValueOnce(1.0);
    mockCoinmarketcapFetch.mockResolvedValueOnce(1.0);

    const result = await fetchFreshPrice('USDC', null);

    expect(result.price_usd).toBe(1.0);
    expect(result.redis_unavailable).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Cache write failed, continuing without caching',
      expect.objectContaining({ error: 'write failed' })
    );
  });
});

describe('refreshAllCachedPrices', () => {
  const { refreshAllCachedPrices } = oracle;

  test('skips the cycle when redis is not connected', async () => {
    mockCacheIsConnected.mockReturnValue(false);

    const result = await refreshAllCachedPrices();

    expect(result).toBeUndefined();
    expect(mockCacheGetClient).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Redis unavailable, skipping scheduled price refresh cycle'
    );
  });

  test('scans cached keys, refreshes prices, and skips history keys', async () => {
    mockCacheIsConnected.mockReturnValue(true);

    const redis = {
      scan: jest
        .fn()
        // single scan pass: returns cursor '0' to terminate, with one price key and one history key
        .mockResolvedValueOnce(['0', ['price:XLM', 'price:history:XLM']]),
    };
    mockCacheGetClient.mockReturnValue(redis);

    // The refresh re-fetches fresh prices for the matched (non-history) key.
    mockStellarFetch.mockResolvedValue(0.1);
    mockCoingeckoFetch.mockResolvedValue(0.1);
    mockCoinmarketcapFetch.mockResolvedValue(0.1);

    const result = await refreshAllCachedPrices();

    expect(redis.scan).toHaveBeenCalledWith('0', 'MATCH', 'price:*', 'COUNT', 100);
    // Only the non-history key is refreshed.
    expect(mockStellarFetch).toHaveBeenCalledWith('XLM', null);
    expect(result).toEqual({ XLM: { price: 0.1, source: 'stellar_dex' } });
  });

  test('aborts the cycle when the redis scan throws', async () => {
    mockCacheIsConnected.mockReturnValue(true);
    const redis = { scan: jest.fn().mockRejectedValueOnce(new Error('scan failed')) };
    mockCacheGetClient.mockReturnValue(redis);

    const result = await refreshAllCachedPrices();

    expect(result).toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Redis scan failed during price refresh, aborting cycle',
      expect.objectContaining({ error: 'scan failed' })
    );
  });
});
