'use strict';

const mockGet = jest.fn();
const mockAxiosCreate = jest.fn(() => ({ get: mockGet }));

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('axios', () => ({
  create: mockAxiosCreate,
}));

jest.mock('../src/config', () => ({
  coingecko: {
    apiKey: 'cg-test-key',
    baseUrl: 'https://api.coingecko.test/api/v3',
  },
  priceSources: {
    circuitCooldownMs: 900000,
    circuitReminderIntervalMs: 300000,
  },
}));

jest.mock('../src/logger', () => mockLogger);

function priceResponse(coinId, price) {
  return { data: { [coinId]: { usd: price } } };
}

function loadSource() {
  jest.resetModules();
  mockGet.mockReset();
  mockAxiosCreate.mockClear();
  mockAxiosCreate.mockReturnValue({ get: mockGet });
  mockLogger.warn.mockClear();
  mockLogger.debug.mockClear();
  mockLogger.error.mockClear();
  return require('../src/services/sources/coingecko');
}

describe('CoinGecko source', () => {
  test('returns USD price for a supported asset (XLM)', async () => {
    const coingecko = loadSource();
    mockGet.mockResolvedValueOnce(priceResponse('stellar', 0.11));

    const price = await coingecko.fetchPrice('XLM');

    expect(price).toBe(0.11);
    expect(mockAxiosCreate).toHaveBeenCalledWith({
      baseURL: 'https://api.coingecko.test/api/v3',
      headers: { Accept: 'application/json', 'x-cg-demo-api-key': 'cg-test-key' },
      timeout: 10000,
    });
    expect(mockGet).toHaveBeenCalledWith('/simple/price', {
      params: { ids: 'stellar', vs_currencies: 'usd' },
    });
  });

  test('returns null for an unsupported asset without calling CoinGecko', async () => {
    const coingecko = loadSource();

    const price = await coingecko.fetchPrice('DOGE');

    expect(price).toBeNull();
    expect(mockGet).not.toHaveBeenCalled();
  });

  test('returns null when the response omits usd price', async () => {
    const coingecko = loadSource();
    mockGet.mockResolvedValueOnce({ data: { stellar: {} } });

    await expect(coingecko.fetchPrice('XLM')).resolves.toBeNull();
  });

  test('throws non-retryable HTTP 401 errors for an invalid API key', async () => {
    const coingecko = loadSource();
    const authError = new Error('unauthorized');
    authError.response = { status: 401 };
    mockGet.mockRejectedValueOnce(authError);

    await expect(coingecko.fetchPrice('XLM')).rejects.toThrow('unauthorized');
    expect(authError.nonRetryable).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith('CoinGecko authentication failed', { assetCode: 'XLM' });
  });

  test('returns null and logs on HTTP 429 rate limits, without throwing', async () => {
    const coingecko = loadSource();
    const rateLimitError = new Error('too many requests');
    rateLimitError.response = { status: 429 };
    mockGet.mockRejectedValueOnce(rateLimitError);

    const price = await coingecko.fetchPrice('XLM');

    expect(price).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith('CoinGecko rate limit hit', { assetCode: 'XLM' });
  });

  test('returns null and logs a generic failure for other errors, without throwing', async () => {
    const coingecko = loadSource();
    const networkError = new Error('ECONNRESET');
    mockGet.mockRejectedValueOnce(networkError);

    const price = await coingecko.fetchPrice('XLM');

    expect(price).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'CoinGecko price fetch failed',
      { assetCode: 'XLM', error: 'ECONNRESET' }
    );
  });

  describe('circuit breaker (#95)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('opens the circuit on a 401 and skips the HTTP request on the next fetch', async () => {
      const coingecko = loadSource();
      const authError = new Error('unauthorized');
      authError.response = { status: 401 };
      mockGet.mockRejectedValueOnce(authError);

      await expect(coingecko.fetchPrice('XLM')).rejects.toThrow('unauthorized');
      expect(coingecko.getCircuitState().open).toBe(true);

      mockGet.mockClear();
      const price = await coingecko.fetchPrice('XLM');

      expect(price).toBeNull();
      expect(mockGet).not.toHaveBeenCalled();
    });

    test('retries after cooldown and closes the circuit on success', async () => {
      const coingecko = loadSource();
      const authError = new Error('unauthorized');
      authError.response = { status: 401 };
      mockGet.mockRejectedValueOnce(authError);
      await expect(coingecko.fetchPrice('XLM')).rejects.toThrow('unauthorized');

      jest.advanceTimersByTime(900001);
      mockGet.mockClear();
      mockGet.mockResolvedValueOnce(priceResponse('stellar', 0.12));

      const price = await coingecko.fetchPrice('XLM');

      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(price).toBe(0.12);
      expect(coingecko.getCircuitState()).toEqual({
        source: 'coingecko',
        open: false,
        openUntil: null,
      });
    });

    test('403s (CDN/firewall block) are unaffected by the circuit breaker', async () => {
      const coingecko = loadSource();
      const forbiddenError = new Error('forbidden');
      forbiddenError.response = { status: 403 };
      mockGet.mockRejectedValue(forbiddenError);

      const price = await coingecko.fetchPrice('XLM');

      expect(price).toBeNull();
      expect(coingecko.getCircuitState().open).toBe(false);
    });

    test('429s are unaffected by the circuit breaker', async () => {
      const coingecko = loadSource();
      const rateLimitError = new Error('too many requests');
      rateLimitError.response = { status: 429 };
      mockGet.mockRejectedValue(rateLimitError);

      await coingecko.fetchPrice('XLM');
      const price = await coingecko.fetchPrice('XLM');

      expect(price).toBeNull();
      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(coingecko.getCircuitState().open).toBe(false);
    });
  });
});
