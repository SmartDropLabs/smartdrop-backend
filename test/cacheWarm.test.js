'use strict';

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../src/services/priceOracle', () => ({
  fetchFreshPrice: jest.fn(),
}));

const logger = require('../src/logger');
const priceOracle = require('../src/services/priceOracle');
const { warmCache } = require('../src/startup/cacheWarm');

function asset(code, issuer = null) {
  return { code, issuer };
}

describe('startup cache warming', () => {
  beforeEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('skips warming when no assets are configured', async () => {
    const summary = await warmCache([], priceOracle, { log: logger });

    expect(summary).toEqual({
      total: 0,
      succeeded: 0,
      failed: 0,
      timedOut: false,
      durationMs: 0,
    });
    expect(priceOracle.fetchFreshPrice).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Cache warm skipped: no watched assets configured');
  });

  test('fetches all configured assets and counts cached successes', async () => {
    priceOracle.fetchFreshPrice
      .mockResolvedValueOnce({ price_usd: 0.12, redis_unavailable: false })
      .mockResolvedValueOnce({ price_usd: 1.0, redis_unavailable: false })
      .mockResolvedValueOnce({ price_usd: null, redis_unavailable: false });

    const assets = [
      asset('XLM'),
      asset('USDC', 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      asset('BAD'),
    ];

    const summary = await warmCache(assets, priceOracle, { log: logger });

    expect(priceOracle.fetchFreshPrice).toHaveBeenCalledTimes(3);
    expect(priceOracle.fetchFreshPrice).toHaveBeenNthCalledWith(1, 'XLM', null);
    expect(priceOracle.fetchFreshPrice).toHaveBeenNthCalledWith(
      2,
      'USDC',
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    );
    expect(priceOracle.fetchFreshPrice).toHaveBeenNthCalledWith(3, 'BAD', null);
    expect(summary).toMatchObject({ total: 3, succeeded: 2, failed: 1, timedOut: false });
    expect(logger.info).toHaveBeenCalledWith('Cache warm complete', expect.objectContaining({
      total: 3,
      succeeded: 2,
      failed: 1,
      timedOut: false,
    }));
  });

  test('starts all asset fetches before awaiting settlement', async () => {
    let resolveXlm;
    let resolveUsdc;
    const xlmPromise = new Promise((resolve) => { resolveXlm = resolve; });
    const usdcPromise = new Promise((resolve) => { resolveUsdc = resolve; });

    priceOracle.fetchFreshPrice
      .mockReturnValueOnce(xlmPromise)
      .mockReturnValueOnce(usdcPromise);

    const warming = warmCache([asset('XLM'), asset('USDC')], priceOracle, { log: logger });
    await Promise.resolve();

    expect(priceOracle.fetchFreshPrice).toHaveBeenCalledTimes(2);

    resolveXlm({ price_usd: 0.12, redis_unavailable: false });
    resolveUsdc({ price_usd: 1.0, redis_unavailable: false });
    await expect(warming).resolves.toMatchObject({ succeeded: 2, failed: 0 });
  });

  test('returns a timeout summary when warming takes too long', async () => {
    jest.useFakeTimers();
    priceOracle.fetchFreshPrice.mockReturnValue(new Promise(() => {}));

    const warming = warmCache([asset('XLM')], priceOracle, {
      timeoutMs: 25,
      log: logger,
    });

    jest.advanceTimersByTime(25);
    await expect(warming).resolves.toEqual({
      total: 1,
      succeeded: 0,
      failed: 1,
      timedOut: true,
      durationMs: 25,
    });
    expect(logger.warn).toHaveBeenCalledWith('Cache warm timed out; starting server anyway', {
      total: 1,
      succeeded: 0,
      failed: 1,
      timedOut: true,
      durationMs: 25,
    });
  });
});
