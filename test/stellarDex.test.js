'use strict';

const mockCall = jest.fn();
const mockLimit = jest.fn(() => ({ call: mockCall }));
const mockOrderbook = jest.fn(() => ({ limit: mockLimit }));
const MockServer = jest.fn().mockImplementation(() => ({
  orderbook: mockOrderbook,
}));

const mockUsdcIssuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA';

jest.mock('stellar-sdk', () => ({
  Server: MockServer,
}));

jest.mock('../src/config', () => ({
  stellar: {
    horizonUrl: 'https://horizon.test',
    usdcIssuer: mockUsdcIssuer,
  },
}));

function loadStellarDex() {
  jest.resetModules();
  mockCall.mockReset();
  mockLimit.mockClear();
  mockOrderbook.mockClear();
  MockServer.mockClear();
  return require('../src/services/sources/stellarDex');
}

function mockOrderbookResponse({ asks = [], bids = [] } = {}) {
  mockCall.mockResolvedValueOnce({ asks, bids });
}

describe('Stellar DEX source', () => {
  test('returns midpoint of best ask and best bid for a normal orderbook', async () => {
    const stellarDex = loadStellarDex();
    mockOrderbookResponse({
      asks: [{ price: '0.12' }],
      bids: [{ price: '0.11' }],
    });

    const price = await stellarDex.fetchPrice('USDC', mockUsdcIssuer);

    expect(price).toBeCloseTo(0.115, 10);
    expect(mockOrderbook).toHaveBeenCalledWith(
      { code: 'USDC', issuer: mockUsdcIssuer },
      undefined,
    );
    expect(mockLimit).toHaveBeenCalledWith(1);
  });

  test('uses best bid only when asks array is empty', async () => {
    const stellarDex = loadStellarDex();
    mockOrderbookResponse({
      asks: [],
      bids: [{ price: '0.11' }],
    });

    const price = await stellarDex.fetchPrice('USDC', mockUsdcIssuer);

    expect(price).toBe(0.11);
  });

  test('uses best ask only when bids array is empty', async () => {
    const stellarDex = loadStellarDex();
    mockOrderbookResponse({
      asks: [{ price: '0.12' }],
      bids: [],
    });

    const price = await stellarDex.fetchPrice('USDC', mockUsdcIssuer);

    expect(price).toBe(0.12);
  });

  test('returns null gracefully when both asks and bids are empty', async () => {
    const stellarDex = loadStellarDex();
    mockOrderbookResponse({
      asks: [],
      bids: [],
    });

    const price = await stellarDex.fetchPrice('USDC', mockUsdcIssuer);

    expect(price).toBeNull();
  });

  test('throws when Horizon returns a non-200 response', async () => {
    const stellarDex = loadStellarDex();
    mockCall.mockRejectedValueOnce(new Error('Horizon request failed with status 404'));

    await expect(stellarDex.fetchPrice('USDC', mockUsdcIssuer)).rejects.toThrow(
      'Horizon request failed with status 404',
    );
  });

  test('throws with timeout message when Horizon times out', async () => {
    const stellarDex = loadStellarDex();
    mockCall.mockRejectedValueOnce(new Error('Request timed out'));

    await expect(stellarDex.fetchPrice('USDC', mockUsdcIssuer)).rejects.toThrow(
      'Request timed out',
    );
  });

  test('uses native XLM orderbook pair when asset has no issuer', async () => {
    const stellarDex = loadStellarDex();
    mockOrderbookResponse({
      asks: [{ price: '0.12' }],
      bids: [{ price: '0.10' }],
    });

    const price = await stellarDex.fetchPrice('XLM');

    expect(price).toBe(0.11);
    expect(mockOrderbook).toHaveBeenCalledWith(
      { native: true },
      { code: 'USDC', issuer: mockUsdcIssuer },
    );
  });
});

describe('Stellar DEX source performance and coverage', () => {
  test('completes mocked requests in under 100ms', async () => {
    const stellarDex = loadStellarDex();
    mockOrderbookResponse({
      asks: [{ price: '0.12' }],
      bids: [{ price: '0.11' }],
    });

    const start = Date.now();
    await stellarDex.fetchPrice('USDC', mockUsdcIssuer);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
  });
});
