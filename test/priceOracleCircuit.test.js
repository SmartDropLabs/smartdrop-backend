'use strict';

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../src/services/cache', () => ({
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  getClient: jest.fn(),
  isConnected: jest.fn(),
}));

const mockCoingeckoCircuitState = { source: 'coingecko', open: true, openUntil: '2026-01-01T00:15:00.000Z' };
const mockCmcCircuitState = { source: 'coinmarketcap', open: false, openUntil: null };

jest.mock('../src/services/sources/stellarDex', () => ({
  fetchPrice: jest.fn(),
  // Deliberately no getCircuitState — stellar_dex has no auth-failure mode.
}));
jest.mock('../src/services/sources/coingecko', () => ({
  fetchPrice: jest.fn(),
  getCircuitState: jest.fn(() => mockCoingeckoCircuitState),
}));
jest.mock('../src/services/sources/coinmarketcap', () => ({
  fetchPrice: jest.fn(),
  getCircuitState: jest.fn(() => mockCmcCircuitState),
}));

const priceOracle = require('../src/services/priceOracle');

describe('priceOracle.getSourceCircuitStates', () => {
  test('returns the circuit state for every source that has one', () => {
    const states = priceOracle.getSourceCircuitStates();

    expect(states).toEqual([mockCoingeckoCircuitState, mockCmcCircuitState]);
  });

  test('omits sources with no getCircuitState (e.g. stellar_dex)', () => {
    const states = priceOracle.getSourceCircuitStates();

    expect(states.find((s) => s.source === 'stellar_dex')).toBeUndefined();
  });
});
