"use strict";

/**
 * Webhook delivery metrics must survive a process restart (issue #343).
 *
 * Each completed delivery is written through to Redis (one aggregate hash
 * plus one hash per webhook) and the counters are reloaded once at startup,
 * so the success/failure rates exposed by GET /metrics and /health keep
 * meaning "all time" rather than "since this process booted".
 */

const { createCacheMock } = require("./helpers/cacheMock");

const mockHelper = createCacheMock();
const { reset, redis } = mockHelper;

jest.mock("../src/services/cache", () => mockHelper.cacheMock);

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
jest.mock("../src/logger", () => mockLogger);

const dispatcher = require("../src/services/webhookDispatcher");

const AGGREGATE_KEY = "webhook:metrics:aggregate";
const WEBHOOK_KEY = (id) => `webhook:metrics:webhook:${id}`;

/** Let the fire-and-forget metric pipelines settle before asserting. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  reset();
  Object.values(mockLogger).forEach((fn) => fn.mockClear());
});

async function record(webhookId, { success, attempts = 1, latencyMs = 25 }) {
  const deliveryId = `dlv_${webhookId}_${Math.random()}`;
  dispatcher.recordDeliveryStart(deliveryId, webhookId);
  dispatcher.recordDeliveryEnd(deliveryId, webhookId, {
    success,
    attempts,
    latencyMs,
  });
  await flush();
}

describe("durable delivery counters", () => {
  test("writes each completed delivery through to Redis", async () => {
    await dispatcher.hydrateMetrics();

    await record("wh_1", { success: true });
    await record("wh_1", { success: false, attempts: 3, latencyMs: 40 });

    expect(await redis.hgetall(AGGREGATE_KEY)).toEqual({
      total: "2",
      success: "1",
      failed: "1",
      total_attempts: "4",
      total_latency_ms: "65",
    });
    expect(await redis.hgetall(WEBHOOK_KEY("wh_1"))).toEqual({
      total: "2",
      success: "1",
      failed: "1",
      total_attempts: "4",
      total_latency_ms: "65",
    });
  });

  test("keeps counters per webhook so a busy one cannot hide the rest", async () => {
    await dispatcher.hydrateMetrics();

    await record("wh_1", { success: true });
    await record("wh_2", { success: false });

    expect(await redis.hgetall(WEBHOOK_KEY("wh_1"))).toMatchObject({
      total: "1",
      success: "1",
    });
    expect(await redis.hgetall(WEBHOOK_KEY("wh_2"))).toMatchObject({
      total: "1",
      failed: "1",
    });
  });

  test("a Redis write failure is logged but never breaks the delivery bookkeeping", async () => {
    redis.pipeline.mockImplementationOnce(() => {
      throw new Error("connection lost");
    });

    const before = dispatcher.getMetrics().aggregate.total;
    expect(() =>
      dispatcher.recordDeliveryEnd("dlv_x", "wh_1", {
        success: true,
        attempts: 1,
        latencyMs: 10,
      }),
    ).not.toThrow();

    expect(dispatcher.getMetrics().aggregate.total).toBe(before + 1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Failed to persist webhook delivery metrics",
      expect.objectContaining({ webhook_id: "wh_1" }),
    );
  });
});

describe("hydrateMetrics", () => {
  test("restores historical counters and derived rates after a restart", async () => {
    // Simulate counters left behind by a previous process.
    await redis.hset(AGGREGATE_KEY, "total", 10);
    await redis.hset(AGGREGATE_KEY, "success", 8);
    await redis.hset(AGGREGATE_KEY, "failed", 2);
    await redis.hset(AGGREGATE_KEY, "total_attempts", 14);
    await redis.hset(AGGREGATE_KEY, "total_latency_ms", 250);
    await redis.hset(WEBHOOK_KEY("wh_42"), "total", 4);
    await redis.hset(WEBHOOK_KEY("wh_42"), "success", 4);
    await redis.hset(WEBHOOK_KEY("wh_42"), "failed", 0);
    await redis.hset(WEBHOOK_KEY("wh_42"), "total_attempts", 4);
    await redis.hset(WEBHOOK_KEY("wh_42"), "total_latency_ms", 100);

    const restored = await dispatcher.hydrateMetrics();
    expect(restored).toBe(10);

    const snapshot = dispatcher.getMetrics();
    expect(snapshot.aggregate).toMatchObject({
      total: 10,
      success: 8,
      failed: 2,
      success_rate: 0.8,
      retry_rate: 0.4,
      avg_latency_ms: 25,
    });
    expect(snapshot.per_webhook.wh_42).toMatchObject({
      total: 4,
      success: 4,
      success_rate: 1,
      avg_latency_ms: 25,
    });
    expect(mockLogger.info).toHaveBeenCalledWith(
      "Webhook delivery metrics loaded from Redis",
      expect.objectContaining({ aggregate_total: 10, webhooks_tracked: 1 }),
    );
  });

  test("replaces the whole read model rather than double-counting", async () => {
    await redis.hset(AGGREGATE_KEY, "total", 5);
    await redis.hset(AGGREGATE_KEY, "success", 5);
    await redis.hset(AGGREGATE_KEY, "failed", 0);

    await dispatcher.hydrateMetrics();
    await dispatcher.hydrateMetrics();

    expect(dispatcher.getMetrics().aggregate.total).toBe(5);
  });

  test("reports empty counters when Redis holds none yet", async () => {
    expect(await dispatcher.hydrateMetrics()).toBe(0);
    expect(dispatcher.getMetrics()).toMatchObject({
      in_flight: 0,
      aggregate: { total: 0, success: 0, failed: 0, success_rate: null },
    });
  });

  test("rejects when Redis is unreachable so the caller can degrade (#342)", async () => {
    redis.hgetall.mockRejectedValueOnce(new Error("connection refused"));

    await expect(dispatcher.hydrateMetrics()).rejects.toThrow(
      "connection refused",
    );
    expect(dispatcher.getMetrics().aggregate.total).toBe(0);
  });
});
