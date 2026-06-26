'use strict';

const mockGet = jest.fn();
const mockAxiosCreate = jest.fn(() => ({ get: mockGet }));

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

const mockUsdcIssuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA';

jest.mock('axios', () => ({
  create: mockAxiosCreate,
}));

jest.mock('../src/config', () => ({
  stellar: {
    usdcIssuer: mockUsdcIssuer,
  },
  coinmarketcap: {
    apiKey: 'cmc-test-key',
    baseUrl: 'https://pro-api.coinmarketcap.test/v1',
    assetIssuerMap: {
      XLM: { symbol: 'XLM' },
      [`USDC:${mockUsdcIssuer}`]: { id: 3408 },
    },
  },
}));

jest.mock('../src/logger', () => mockLogger);

function quoteResponse(symbol, price) {
  return {
    data: {
      data: {
        [symbol]: {
          quote: {
            USD: { price },
          },
        },
      },
    },
  };
}

function loadSource() {
  jest.resetModules();
  mockGet.mockReset();
  mockAxiosCreate.mockClear();
  mockAxiosCreate.mockReturnValue({ get: mockGet });
  mockLogger.warn.mockClear();
  mockLogger.debug.mockClear();
  return require('../src/services/sources/coinmarketcap');
}

describe('CoinMarketCap source', () => {
  test('returns USD price on supported XLM response', async () => {
    const coinmarketcap = loadSource();
    mockGet.mockResolvedValueOnce(quoteResponse('XLM', 0.1234));

    const price = await coinmarketcap.fetchPrice('XLM');

    expect(price).toBe(0.1234);
    expect(mockAxiosCreate).toHaveBeenCalledWith({
      baseURL: 'https://pro-api.coinmarketcap.test/v1',
      headers: {
        Accept: 'application/json',
        'X-CMC_PRO_API_KEY': 'cmc-test-key',
      },
      timeout: 10000,
    });
    expect(mockGet).toHaveBeenCalledWith('/cryptocurrency/quotes/latest', {
      params: {
        symbol: 'XLM',
        convert: 'USD',
      },
    });
  });

  test('returns null for unsupported asset symbols without calling CMC', async () => {
    const coinmarketcap = loadSource();

    const price = await coinmarketcap.fetchPrice('DOGE');

    expect(price).toBeNull();
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Asset not supported by CoinMarketCap',
      expect.objectContaining({ assetCode: 'DOGE' })
    );
  });

  test('returns USDC price only for the configured Stellar issuer', async () => {
    const coinmarketcap = loadSource();
    mockGet.mockResolvedValueOnce(quoteResponse('3408', 1.0003));

    const price = await coinmarketcap.fetchPrice('USDC', mockUsdcIssuer);

    expect(price).toBe(1.0003);
    expect(mockGet).toHaveBeenCalledWith('/cryptocurrency/quotes/latest', {
      params: {
        id: 3408,
        convert: 'USD',
      },
    });
  });

  test('returns null for USDC with an unknown Stellar issuer', async () => {
    const coinmarketcap = loadSource();
    const wrongIssuer = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

    const price = await coinmarketcap.fetchPrice('USDC', wrongIssuer);

    expect(price).toBeNull();
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Issuer not supported by CoinMarketCap',
      { assetCode: 'USDC', issuer: wrongIssuer }
    );
  });

  test('throws non-retryable HTTP 401 errors for invalid API keys', async () => {
    const coinmarketcap = loadSource();
    const authError = new Error('unauthorized');
    authError.response = { status: 401 };
    mockGet.mockRejectedValueOnce(authError);

    await expect(coinmarketcap.fetchPrice('XLM')).rejects.toThrow('unauthorized');
    expect(authError.nonRetryable).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'CoinMarketCap authentication failed',
      { assetCode: 'XLM' }
    );
  });

  test('returns null and logs retry_after on HTTP 429 rate limits', async () => {
    const coinmarketcap = loadSource();
    const rateLimitError = new Error('too many requests');
    rateLimitError.response = {
      status: 429,
      headers: { 'retry-after': '60' },
    };
    mockGet.mockRejectedValueOnce(rateLimitError);

    const price = await coinmarketcap.fetchPrice('XLM');

    expect(price).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'CoinMarketCap rate limit hit',
      { assetCode: 'XLM', retry_after: '60' }
    );
  });

  test('returns null when CMC omits quote data for a mapped symbol', async () => {
    const coinmarketcap = loadSource();
    mockGet.mockResolvedValueOnce({ data: { data: { XLM: {} } } });

    await expect(coinmarketcap.fetchPrice('XLM')).resolves.toBeNull();
  });
});
