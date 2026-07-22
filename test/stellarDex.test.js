'use strict';

const mockOrderbook = jest.fn();
const mockServer = { orderbook: mockOrderbook };
const mockServerConstructor = jest.fn(() => mockServer);
const mockNativeAsset = { native: true };
const mockAsset = jest.fn(function Asset(code, issuer) {
  return { code, issuer };
});
mockAsset.native = jest.fn(() => mockNativeAsset);

jest.mock('stellar-sdk', () => ({
  Horizon: {
    Server: mockServerConstructor,
  },
  Asset: mockAsset,
}));

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const config = require('../src/config');
const logger = require('../src/logger');
const stellarDex = require('../src/services/sources/stellarDex');

const ISSUER = 'G'.padEnd(56, 'A');

function queueOrderBook(result) {
  const call = jest.fn();
  if (result instanceof Error) {
    call.mockRejectedValue(result);
  } else {
    call.mockResolvedValue(result);
  }

  const limit = jest.fn(() => ({ call }));
  mockOrderbook.mockImplementationOnce(() => ({ limit }));
  return { call, limit };
}

beforeEach(() => {
  mockOrderbook.mockReset();
  mockServerConstructor.mockClear();
  mockAsset.mockClear();
  mockAsset.native.mockClear();
  logger.warn.mockClear();
  logger.debug.mockClear();
});

describe('Stellar DEX source', () => {
  test('returns midpoint of best ask and best bid for issued assets', async () => {
    queueOrderBook({
      bids: [{ price: '2.0' }],
      asks: [{ price: '2.2' }],
    });
    queueOrderBook({
      bids: [{ price: '0.10' }],
      asks: [{ price: '0.12' }],
    });

    await expect(stellarDex.fetchPrice('TEST', ISSUER)).resolves.toBeCloseTo(0.231);

    expect(mockOrderbook).toHaveBeenNthCalledWith(
      1,
      { code: 'TEST', issuer: ISSUER },
      mockNativeAsset
    );
    expect(mockOrderbook).toHaveBeenNthCalledWith(
      2,
      mockNativeAsset,
      { code: 'USDC', issuer: config.stellar.usdcIssuer }
    );
  });

  test('uses best bid when asks are empty', async () => {
    queueOrderBook({
      bids: [{ price: '0.11' }],
      asks: [],
    });

    await expect(stellarDex.fetchPrice('XLM')).resolves.toBe(0.11);
  });

  test('uses best ask when bids are empty', async () => {
    queueOrderBook({
      bids: [],
      asks: [{ price: '0.12' }],
    });

    await expect(stellarDex.fetchPrice('XLM')).resolves.toBe(0.12);
  });

  test('returns null when asks and bids are empty', async () => {
    queueOrderBook({
      bids: [],
      asks: [],
    });

    await expect(stellarDex.fetchPrice('XLM')).resolves.toBeNull();
  });

  test('returns null for issued assets when issuer is missing', async () => {
    await expect(stellarDex.fetchPrice('USDC')).resolves.toBeNull();

    expect(mockOrderbook).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      'Stellar DEX issuer required for issued asset',
      { assetCode: 'USDC' }
    );
  });

  test('throws when Horizon returns a non-200 error', async () => {
    const error = new Error('Horizon request failed with status 500');
    error.response = { status: 500 };
    queueOrderBook(error);

    await expect(stellarDex.fetchPrice('XLM')).rejects.toThrow('status 500');
    expect(logger.warn).toHaveBeenCalledWith(
      'Stellar DEX price fetch failed',
      expect.objectContaining({ assetCode: 'XLM', error: error.message })
    );
  });

  test('throws timeout errors from Horizon', async () => {
    const error = new Error('timeout of 10000ms exceeded');
    error.code = 'ECONNABORTED';
    queueOrderBook(error);

    await expect(stellarDex.fetchPrice('XLM')).rejects.toThrow('timeout');
    expect(logger.warn).toHaveBeenCalledWith(
      'Stellar DEX price fetch failed',
      expect.objectContaining({ assetCode: 'XLM', error: error.message })
    );
  });

  test('throws and logs when XLM/USD conversion lookup fails', async () => {
    queueOrderBook({
      bids: [{ price: '2.0' }],
      asks: [{ price: '2.2' }],
    });
    const error = new Error('XLM/USDC lookup failed');
    queueOrderBook(error);

    await expect(stellarDex.fetchPrice('TEST', ISSUER)).rejects.toThrow(
      'XLM/USDC lookup failed'
    );
    expect(logger.warn).toHaveBeenCalledWith('XLM/USDC price fetch failed', {
      error: error.message,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'Stellar DEX price fetch failed',
      expect.objectContaining({ assetCode: 'TEST', issuer: ISSUER })
    );
  });

  test('uses the native XLM/USDC orderbook for XLM without issuer', async () => {
    queueOrderBook({
      bids: [{ price: '0.11' }],
      asks: [{ price: '0.12' }],
    });

    await expect(stellarDex.fetchPrice('XLM')).resolves.toBeCloseTo(0.115);

    expect(mockOrderbook).toHaveBeenCalledTimes(1);
    expect(mockAsset.native).toHaveBeenCalledTimes(1);
    expect(mockAsset).toHaveBeenCalledWith('USDC', config.stellar.usdcIssuer);
    expect(mockOrderbook).toHaveBeenCalledWith(
      mockNativeAsset,
      { code: 'USDC', issuer: config.stellar.usdcIssuer }
    );
  });
});
