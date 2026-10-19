'use strict';

/**
 * Webhook retry worker queue-depth reporting (issue #235).
 */

const { createCacheMock } = require('./helpers/cacheMock');

const mockHelper = createCacheMock();
const { reset, redis } = mockHelper;

jest.mock('../src/services/cache', () => mockHelper.cacheMock);
jest.mock('../src/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const mockAttempt = jest.fn();
jest.mock('../src/services/webhookDispatcher', () => ({
  attempt: mockAttempt,
}));

const mockPopDueRetries = jest.fn();
const mockCountPendingRetries = jest.fn();
jest.mock('../src/repositories/deliveryRepository', () => ({
  popDueRetries: mockPopDueRetries,
  countPendingRetries: mockCountPendingRetries,
}));

const worker = require('../src/jobs/webhookRetryWorker');

beforeEach(() => {
  reset();
  mockAttempt.mockReset().mockResolvedValue({});
  mockPopDueRetries.mockReset().mockResolvedValue([]);
  mockCountPendingRetries.mockReset().mockResolvedValue(0);
});

afterEach(() => {
  worker.stop();
});

describe('webhook retry worker queue stats', () => {
  test('reports the pending retry queue depth', async () => {
    mockCountPendingRetries.mockResolvedValue(17);

    const stats = await worker.getQueueStats();

    expect(stats.pendingRetries).toBe(17);
  });

  test('distinguishes an unreadable queue from an empty one', async () => {
    mockCountPendingRetries.mockResolvedValue(null);

    const stats = await worker.getQueueStats();

    expect(stats.pendingRetries).toBeNull();
  });

  test('records the size of the last claimed batch', async () => {
    // totalRetriesProcessed is a lifetime counter on module state, so it is
    // asserted as a delta rather than an absolute.
    const before = (await worker.getQueueStats()).totalRetriesProcessed;
    mockPopDueRetries.mockResolvedValue(['dlv_1', 'dlv_2', 'dlv_3']);

    await worker.tick();
    const stats = await worker.getQueueStats();

    expect(stats.lastBatchSize).toBe(3);
    expect(stats.totalRetriesProcessed - before).toBe(3);
  });

  test('an empty poll records a batch size of zero, not a stale previous size', async () => {
    mockPopDueRetries.mockResolvedValueOnce(['dlv_1', 'dlv_2']);
    await worker.tick();

    mockPopDueRetries.mockResolvedValueOnce([]);
    await worker.tick();

    const stats = await worker.getQueueStats();
    expect(stats.lastBatchSize).toBe(0);
  });

  test('reports an average delivery latency once retries have been attempted', async () => {
    mockPopDueRetries.mockResolvedValue(['dlv_1', 'dlv_2']);

    await worker.tick();
    const stats = await worker.getQueueStats();

    expect(stats.avgDeliveryLatencyMs).not.toBeNull();
    expect(stats.avgDeliveryLatencyMs).toBeGreaterThanOrEqual(0);
  });

  test('reports a null average latency before any retry has been attempted', async () => {
    // The worker keeps its counters in module state, so a freshly loaded
    // copy is the only way to observe the pre-first-retry values regardless
    // of the order tests run in.
    let freshWorker;
    jest.isolateModules(() => {
      freshWorker = require('../src/jobs/webhookRetryWorker');
    });

    const stats = await freshWorker.getQueueStats();

    expect(stats.avgDeliveryLatencyMs).toBeNull();
    expect(stats.totalRetriesProcessed).toBe(0);
  });

  test('counts a retry that threw toward latency, since a timeout is the case that matters', async () => {
    const before = (await worker.getQueueStats()).totalRetriesProcessed;
    mockPopDueRetries.mockResolvedValue(['dlv_boom']);
    mockAttempt.mockRejectedValue(new Error('delivery blew up'));

    await worker.tick();
    const stats = await worker.getQueueStats();

    expect(stats.totalRetriesProcessed - before).toBe(1);
    expect(stats.avgDeliveryLatencyMs).not.toBeNull();
  });

  test('getHealth carries the throughput fields alongside liveness', async () => {
    mockPopDueRetries.mockResolvedValue(['dlv_1']);
    await worker.tick();

    const health = worker.getHealth();

    expect(health).toEqual(expect.objectContaining({
      lastBatchSize: 1,
      avgDeliveryLatencyMs: expect.any(Number),
    }));
  });
});
