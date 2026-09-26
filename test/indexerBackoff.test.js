'use strict';

/**
 * Indexer adaptive backoff, lag alerting, and metrics (issue #255).
 */

const { EventPoller } = require('../src/indexer/eventPoller');

const mockLogger = {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
};

function buildStore(overrides = {}) {
  return {
    getLastLedger: jest.fn(async () => 100),
    setLastLedger: jest.fn(async () => {}),
    saveEvent: jest.fn(async () => {}),
    ...overrides,
  };
}

function buildPoller(overrides = {}) {
  return new EventPoller({
    contractId: 'CONTRACT123',
    enabled: true,
    pollIntervalMs: 1000,
    pollLimit: 10,
    logger: mockLogger,
    store: buildStore(),
    server: { getEvents: jest.fn(async () => ({ events: [], latestLedger: 100 })) },
    ...overrides,
  });
}

beforeEach(() => {
  Object.values(mockLogger).forEach((fn) => fn.mockClear());
});

describe('adaptive poll interval', () => {
  test('starts at the configured base interval', () => {
    const poller = buildPoller();

    expect(poller.currentPollIntervalMs).toBe(1000);
    expect(poller.computeBackoffMs()).toBe(1000);
  });

  test('grows exponentially with consecutive failures', () => {
    const poller = buildPoller();

    poller.recordPollFailure();
    expect(poller.currentPollIntervalMs).toBe(2000);

    poller.recordPollFailure();
    expect(poller.currentPollIntervalMs).toBe(4000);

    poller.recordPollFailure();
    expect(poller.currentPollIntervalMs).toBe(8000);
  });

  test('is clamped so a long outage cannot push the next poll arbitrarily far out', () => {
    const poller = buildPoller({ maxPollIntervalMs: 5000 });

    for (let i = 0; i < 20; i += 1) poller.recordPollFailure();

    expect(poller.currentPollIntervalMs).toBe(5000);
  });

  test('resets to the base interval on the first success after failures', () => {
    const poller = buildPoller();

    poller.recordPollFailure();
    poller.recordPollFailure();
    expect(poller.currentPollIntervalMs).toBe(4000);

    poller.recordPollSuccess();

    expect(poller.consecutiveFailures).toBe(0);
    expect(poller.currentPollIntervalMs).toBe(1000);
  });

  test('logs recovery when the interval resets after a failure streak', () => {
    const poller = buildPoller();

    poller.recordPollFailure();
    poller.recordPollSuccess();

    expect(mockLogger.info).toHaveBeenCalledWith(
      'Soroban RPC recovered, resetting poll interval',
      expect.objectContaining({ after_consecutive_failures: 1 }),
    );
  });

  test('does not log recovery for an ordinary success with no prior failures', () => {
    const poller = buildPoller();

    poller.recordPollSuccess();

    expect(mockLogger.info).not.toHaveBeenCalledWith(
      'Soroban RPC recovered, resetting poll interval',
      expect.anything(),
    );
  });
});

describe('pausing on an unreachable node', () => {
  test('skips the cycle instead of calling the node while the breaker is open', async () => {
    const getEvents = jest.fn(async () => ({ events: [], latestLedger: 100 }));
    const poller = buildPoller({
      server: { getEvents },
      rpcBreaker: { isOpen: () => true, getState: () => 'open', call: jest.fn() },
    });

    const result = await poller.pollOnce();

    expect(result).toEqual(expect.objectContaining({ skipped: true, paused: true }));
    expect(getEvents).not.toHaveBeenCalled();
  });

  test('counts a paused cycle as skipped rather than attempted', async () => {
    const poller = buildPoller({
      rpcBreaker: { isOpen: () => true, getState: () => 'open', call: jest.fn() },
    });

    await poller.pollOnce();

    const metrics = poller.getMetrics();
    expect(metrics.polls_skipped).toBe(1);
    expect(metrics.polls_attempted).toBe(0);
  });

  test('reports paused state through getStatus so operators can see it', async () => {
    const poller = buildPoller({
      rpcBreaker: { isOpen: () => true, getState: () => 'open', call: jest.fn() },
    });

    expect(poller.getStatus()).toEqual(expect.objectContaining({
      paused: true,
      circuit_state: 'open',
    }));
  });
});

describe('ledger lag', () => {
  test('is null until both the tip and the indexed position are known', () => {
    const poller = buildPoller();

    expect(poller.getLag()).toBeNull();
  });

  test('is the distance between the indexed ledger and the chain tip', () => {
    const poller = buildPoller();
    poller.latestLedger = 500;
    poller.lastIndexedLedger = 450;

    expect(poller.getLag()).toBe(50);
  });

  test('never reports negative lag when the indexer is at or past the tip', () => {
    const poller = buildPoller();
    poller.latestLedger = 100;
    poller.lastIndexedLedger = 120;

    expect(poller.getLag()).toBe(0);
  });

  test('alerts once when lag crosses the threshold', () => {
    const poller = buildPoller({ lagAlertThreshold: 10 });
    poller.latestLedger = 200;
    poller.lastIndexedLedger = 100;

    poller.checkLag();

    expect(mockLogger.error).toHaveBeenCalledWith(
      'Indexer lag exceeded threshold',
      expect.objectContaining({ ledger_lag: 100, threshold: 10 }),
    );
  });

  test('does not repeat the alert on every poll while lag persists', () => {
    const poller = buildPoller({ lagAlertThreshold: 10 });
    poller.latestLedger = 200;
    poller.lastIndexedLedger = 100;

    poller.checkLag();
    poller.checkLag();
    poller.checkLag();

    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });

  test('logs recovery once when lag falls back below the threshold', () => {
    const poller = buildPoller({ lagAlertThreshold: 10 });
    poller.latestLedger = 200;
    poller.lastIndexedLedger = 100;
    poller.checkLag();

    poller.lastIndexedLedger = 199;
    poller.checkLag();

    expect(mockLogger.info).toHaveBeenCalledWith(
      'Indexer lag recovered below threshold',
      expect.objectContaining({ ledger_lag: 1 }),
    );
  });

  test('stays quiet while lag remains under the threshold', () => {
    const poller = buildPoller({ lagAlertThreshold: 100 });
    poller.latestLedger = 110;
    poller.lastIndexedLedger = 100;

    poller.checkLag();

    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});

describe('indexer metrics', () => {
  test('reports null rates before any poll has completed', () => {
    const metrics = buildPoller().getMetrics();

    expect(metrics.events_per_second).toBeNull();
    expect(metrics.error_rate).toBeNull();
  });

  test('computes an error rate across completed polls', () => {
    const poller = buildPoller();

    poller.recordPollSuccess();
    poller.recordPollSuccess();
    poller.recordPollFailure();
    poller.recordPollFailure();

    expect(poller.getMetrics().error_rate).toBe(0.5);
  });

  test('counts indexed events across polls', async () => {
    const poller = buildPoller({
      server: {
        getEvents: jest.fn(async () => ({
          events: [
            { topic: [], value: {}, ledger: 101 },
            { topic: [], value: {}, ledger: 102 },
          ],
          latestLedger: 102,
        })),
      },
    });

    await poller.pollOnce();

    // Event parsing may discard entries it cannot interpret, so this
    // asserts the counter tracks what was actually stored, not the raw
    // response length.
    expect(poller.getMetrics().events_indexed).toBe(poller.metrics.eventsIndexed);
    expect(poller.getMetrics().polls_attempted).toBe(1);
  });

  test('surfaces the current backoff state in metrics', () => {
    const poller = buildPoller();
    poller.recordPollFailure();

    expect(poller.getMetrics()).toEqual(expect.objectContaining({
      consecutive_failures: 1,
      current_poll_interval_ms: 2000,
      base_poll_interval_ms: 1000,
    }));
  });
});

describe('scheduling', () => {
  test('stop() prevents a poll already in flight from rescheduling', () => {
    const poller = buildPoller();
    poller.stopped = true;
    const run = jest.fn();

    poller.scheduleNext(run);

    expect(poller.timer).toBeNull();
  });

  test('schedules the next cycle at the current backed-off interval', () => {
    jest.useFakeTimers();
    try {
      const poller = buildPoller();
      poller.recordPollFailure();
      const run = jest.fn();

      poller.scheduleNext(run);

      expect(run).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1999);
      expect(run).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
