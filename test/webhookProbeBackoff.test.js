'use strict';

// #615 — probe retries back off exponentially (with jitter) instead of
// re-trying a failing endpoint at a fixed interval.

jest.mock('axios', () => ({ head: jest.fn(), get: jest.fn(), post: jest.fn() }));
jest.mock('../src/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const axios = require('axios');
const { probeReachability, probeRetryDelayMs } = require('../src/services/webhook');

describe('probeRetryDelayMs', () => {
  afterEach(() => jest.restoreAllMocks());

  test('doubles per attempt from the base delay', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    expect([0, 1, 2, 3].map((a) => probeRetryDelayMs(a, 100, 10_000))).toEqual([100, 200, 400, 800]);
  });

  test('is capped at the max delay', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    expect(probeRetryDelayMs(10, 100, 1_000)).toBe(1_000);
  });

  test('adds at most 10% jitter', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.999);
    const delay = probeRetryDelayMs(2, 100, 10_000);
    expect(delay).toBeGreaterThan(400);
    expect(delay).toBeLessThanOrEqual(440);
  });
});

describe('probeReachability retry schedule', () => {
  afterEach(() => jest.restoreAllMocks());

  test('waits longer before each successive retry', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const delays = [];
    jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms) => {
      delays.push(ms);
      fn();
      return 0;
    });
    const transient = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    axios.head.mockRejectedValue(transient);
    axios.get.mockRejectedValue(transient);

    const result = await probeReachability('https://example.com/hook', {
      retryAttempts: 3,
      retryDelayMs: 10,
      retryMaxDelayMs: 1_000,
    });

    expect(result.reachable).toBe(false);
    // Three retries for HEAD, then three for GET, each schedule exponential.
    expect(delays).toEqual([10, 20, 40, 10, 20, 40]);
  });
});
