'use strict';

const mockRefreshAll = jest.fn();
const mockEvaluateAll = jest.fn();
const mockNotifyPriceUpdates = jest.fn();
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../src/services/priceOracle', () => ({
  refreshAllCachedPrices: mockRefreshAll,
}));

jest.mock('../src/services/alerts', () => ({
  evaluateAll: mockEvaluateAll,
}));

jest.mock('../src/ws/PriceSubscriptionManager', () => ({
  notifyPriceUpdates: mockNotifyPriceUpdates,
}));

jest.mock('../src/config', () => ({
  price: {
    refreshInterval: 30,
    refreshMaxCycleMs: 90000,
  },
}));

jest.mock('../src/logger', () => mockLogger);

// We need to mock node-cron to control when the callback fires
jest.mock('node-cron', () => {
  let capturedCallback = null;
  return {
    schedule: jest.fn((_expr, opts, cb) => {
      // Support both (expr, cb) and (expr, opts, cb) signatures
      if (typeof opts === 'function') {
        capturedCallback = opts;
      } else {
        capturedCallback = cb;
      }
      return {
        stop: jest.fn(),
      };
    }),
    __getCronCallback: () => capturedCallback,
    __reset: () => { capturedCallback = null; },
  };
});

const cron = require('node-cron');
const priceRefresh = require('../src/jobs/priceRefresh');

beforeEach(() => {
  jest.clearAllMocks();
  cron.__reset();
  mockRefreshAll.mockResolvedValue({ XLM: { price: 0.1, source: 'stellar_dex' } });
  mockEvaluateAll.mockResolvedValue(undefined);
});

describe('priceRefresh job reentrancy guard (#71)', () => {
  test('starts and registers a cron callback', () => {
    priceRefresh.start();
    expect(cron.schedule).toHaveBeenCalled();
    expect(cron.__getCronCallback()).toBeDefined();
  });

  test('skips tick when previous cycle is still running', async () => {
    priceRefresh.start();
    const cb = cron.__getCronCallback();

    // Make the first call slow
    let resolveFirst;
    mockRefreshAll.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));

    // Fire first tick
    const p1 = cb();
    // Give it a microtick to enter the running state
    await new Promise((r) => setTimeout(r, 5));

    // Fire second tick — should be skipped
    await cb();

    expect(mockRefreshAll).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Skipping price refresh tick, previous cycle still running',
      expect.objectContaining({ runningForMs: expect.any(Number) })
    );

    // Resolve the first tick
    resolveFirst();
    await p1;
  });

  test('logs error when cycle exceeds max duration', async () => {
    priceRefresh.start();
    const cb = cron.__getCronCallback();

    // Make refresh take longer than the mock max cycle (we'll override config)
    const configMock = require('../src/config');
    const originalMax = configMock.price.refreshMaxCycleMs;
    configMock.price.refreshMaxCycleMs = 50; // 50ms

    try {
      mockRefreshAll.mockImplementationOnce(() => new Promise((r) => setTimeout(r, 200)));

      await cb();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Price refresh cycle exceeded max duration',
        expect.objectContaining({ maxCycleMs: 50 })
      );
    } finally {
      configMock.price.refreshMaxCycleMs = originalMax;
    }
  });

  test('resets running flag after cycle completes', async () => {
    priceRefresh.start();
    const cb = cron.__getCronCallback();

    mockRefreshAll.mockResolvedValueOnce({ XLM: { price: 0.1, source: 'stellar_dex' } });
    await cb();

    // Second tick should not be skipped
    mockRefreshAll.mockResolvedValueOnce({ XLM: { price: 0.2, source: 'stellar_dex' } });
    await cb();

    expect(mockRefreshAll).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      'Skipping price refresh tick, previous cycle still running',
      expect.anything()
    );
  });

  test('resets running flag even when cycle throws', async () => {
    priceRefresh.start();
    const cb = cron.__getCronCallback();

    mockRefreshAll.mockRejectedValueOnce(new Error('boom'));
    await cb();

    // Second tick should run normally
    mockRefreshAll.mockResolvedValueOnce({});
    await cb();

    expect(mockRefreshAll).toHaveBeenCalledTimes(2);
  });

  test('getHealth returns healthy state after successful run', async () => {
    priceRefresh.start();
    const cb = cron.__getCronCallback();
    await cb();

    const health = priceRefresh.getHealth();
    expect(health.healthy).toBe(true);
    expect(health.lastSuccessAt).toBeDefined();
    expect(health.lastError).toBeNull();
    expect(health.stalled).toBe(false);
    expect(mockEvaluateAll).toHaveBeenCalledTimes(1);
  });

  test('getHealth reports error after failed cycle', async () => {
    priceRefresh.start();
    const cb = cron.__getCronCallback();

    mockRefreshAll.mockRejectedValueOnce(new Error('redis down'));
    await cb();

    const health = priceRefresh.getHealth();
    expect(health.lastError).toBe('redis down');
  });

  test('stop clears the scheduled task', () => {
    priceRefresh.start();
    priceRefresh.stop();

    const health = priceRefresh.getHealth();
    expect(health.healthy).toBe(false);
  });
});
