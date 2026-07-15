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
    apiKey: 'coingecko-test-key',
    baseUrl: 'https://api.coingecko.test/api/v3',
  },
}));

jest.mock('../src/logger', () => mockLogger);

function loadSource() {
  jest.resetModules();
  mockGet.mockReset();
  mockAxiosCreate.mockClear();
  mockAxiosCreate.mockReturnValue({ get: mockGet });
  mockLogger.warn.mockClear();
  mockLogger.debug.mockClear();
  return require('../src/services/sources/coingecko');
}

describe('CoinGecko source', () => {
  test('returns USD price for supported assets', async () => {
    const coingecko = loadSource();
    mockGet.mockResolvedValueOnce({ data: { stellar: { usd: 0.1234 } } });

    const price = await coingecko.fetchPrice('XLM');

    expect(price).toBe(0.1234);
    expect(mockAxiosCreate).toHaveBeenCalledWith({
      baseURL: 'https://api.coingecko.test/api/v3',
      headers: {
        Accept: 'application/json',
        'x-cg-demo-api-key': 'coingecko-test-key',
      },
      timeout: 10000,
    });
  });

  test.each([401, 403])('throws non-retryable HTTP %i errors', async (status) => {
    const coingecko = loadSource();
    const authError = new Error(`coingecko ${status}`);
    authError.response = { status };
    mockGet.mockRejectedValueOnce(authError);

    await expect(coingecko.fetchPrice('XLM')).rejects.toThrow(`coingecko ${status}`);
    expect(authError.nonRetryable).toBe(true);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  test('keeps HTTP 429 rate limits on the retryable null-return path', async () => {
    const coingecko = loadSource();
    const rateLimitError = new Error('too many requests');
    rateLimitError.response = { status: 429 };
    mockGet.mockRejectedValueOnce(rateLimitError);

    await expect(coingecko.fetchPrice('XLM')).resolves.toBeNull();
    expect(rateLimitError.nonRetryable).toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith('CoinGecko rate limit hit', { assetCode: 'XLM' });
  });
});
