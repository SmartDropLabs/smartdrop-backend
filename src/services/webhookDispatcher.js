"use strict";

const crypto = require("crypto");
const axios = require("axios");
const config = require("../config");
const logger = require("../logger");
const cache = require("./cache");
const signature = require("./webhookSignature");
const events = require("./webhookEvents");
const webhookRepo = require("../repositories/webhookRepository");
const deliveryRepo = require("../repositories/deliveryRepository");
const { requestContext } = require("../middleware/requestId");
const { assertPublicTarget } = require("./ssrfGuard");

const USER_AGENT = "SmartDrop-Webhooks/1.0";
const WEBHOOK_CACHE_TTL_MS = 60_000;
const webhookCache = new Map();

// ── Delivery metrics (#343) ─────────────────────────────────────────────
// Counters live in Redis (hash-per-webhook plus one aggregate hash) so a
// process restart no longer zeros historical delivery success rates. The
// in-memory copy below is the read model getMetrics() answers from: it is
// loaded once at startup via hydrateMetrics() and then written through on
// every completed delivery. Redis is the durable copy; if it is unavailable
// the write is logged and dropped rather than failing the delivery.
const METRICS_AGGREGATE_KEY = 'webhook:metrics:aggregate';
const METRICS_WEBHOOK_KEY_PREFIX = 'webhook:metrics:webhook:';

const metrics = {
  _deliveries: new Map(), // webhook_id → { total, success, failed, totalAttempts, totalLatencyMs }
  _inFlight: new Set(), // delivery IDs currently being attempted
  _aggregate: {
    total: 0,
    success: 0,
    failed: 0,
    totalAttempts: 0,
    totalLatencyMs: 0,
  },
};

function _ensureWebhookMetrics(webhookId) {
  if (!metrics._deliveries.has(webhookId)) {
    metrics._deliveries.set(webhookId, {
      total: 0,
      success: 0,
      failed: 0,
      totalAttempts: 0,
      totalLatencyMs: 0,
    });
  }
  return metrics._deliveries.get(webhookId);
}

function _fromRedisFields(raw) {
  const num = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    total: num(raw.total),
    success: num(raw.success),
    failed: num(raw.failed),
    totalAttempts: num(raw.total_attempts),
    totalLatencyMs: num(raw.total_latency_ms),
  };
}

/**
 * Best-effort write-through of one completed delivery's contribution to the
 * durable counters. Fire-and-forget on purpose: a metrics write must never
 * be able to fail or delay the delivery it is describing.
 */
function _persistDeliveryMetrics(webhookId, { success, attempts, latencyMs }) {
  try {
    const redis = cache.getClient();
    const pipeline = redis.pipeline();
    const deltas = [
      ['total', 1],
      [success ? 'success' : 'failed', 1],
      ['total_attempts', attempts],
      ['total_latency_ms', latencyMs],
    ];
    for (const [field, by] of deltas) {
      pipeline.hincrby(METRICS_AGGREGATE_KEY, field, by);
      pipeline.hincrby(`${METRICS_WEBHOOK_KEY_PREFIX}${webhookId}`, field, by);
    }
    pipeline
      .exec()
      .then((results) => {
        // ioredis resolves exec() with per-command [err, result] pairs; a
        // rejected command (WRONGTYPE, OOM, …) would otherwise be invisible.
        const failed = (results || []).find(([err]) => err);
        if (failed) throw failed[0];
      })
      .catch((err) => {
        logger.warn('Failed to persist webhook delivery metrics', {
          webhook_id: webhookId,
          error: err.message,
        });
      });
  } catch (err) {
    logger.warn('Failed to persist webhook delivery metrics', {
      webhook_id: webhookId,
      error: err.message,
    });
  }
}

async function _scanMetricKeys(pattern) {
  const redis = cache.getClient();
  const keys = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = String(nextCursor);
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

/**
 * Loads the durable counters back into the in-memory read model (#343).
 *
 * Called once from startServer(), before the server begins accepting
 * requests, so no delivery can be counted twice (the overwrite below would
 * otherwise discard a locally-recorded delta). Rejects if Redis cannot be
 * read — callers are expected to treat that as "start with empty counters",
 * not as a fatal startup error (#342).
 */
async function hydrateMetrics() {
  const redis = cache.getClient();
  const [aggregateRaw, webhookKeys] = await Promise.all([
    redis.hgetall(METRICS_AGGREGATE_KEY),
    _scanMetricKeys(`${METRICS_WEBHOOK_KEY_PREFIX}*`),
  ]);

  metrics._aggregate = _fromRedisFields(aggregateRaw || {});
  metrics._deliveries.clear();

  const perWebhook = await Promise.all(
    webhookKeys.map(async (key) => [
      key.slice(METRICS_WEBHOOK_KEY_PREFIX.length),
      await redis.hgetall(key),
    ]),
  );
  for (const [webhookId, raw] of perWebhook) {
    metrics._deliveries.set(webhookId, _fromRedisFields(raw || {}));
  }

  logger.info('Webhook delivery metrics loaded from Redis', {
    aggregate_total: metrics._aggregate.total,
    webhooks_tracked: metrics._deliveries.size,
  });
  return metrics._aggregate.total;
}

function recordDeliveryStart(deliveryId, webhookId) {
  metrics._inFlight.add(deliveryId);
  _ensureWebhookMetrics(webhookId);
}

function recordDeliveryEnd(
  deliveryId,
  webhookId,
  { success, attempts, latencyMs },
) {
  metrics._inFlight.delete(deliveryId);
  const wm = _ensureWebhookMetrics(webhookId);
  const ag = metrics._aggregate;

  wm.total += 1;
  wm.totalAttempts += attempts;
  wm.totalLatencyMs += latencyMs;
  ag.total += 1;
  ag.totalAttempts += attempts;
  ag.totalLatencyMs += latencyMs;

  if (success) {
    wm.success += 1;
    ag.success += 1;
  } else {
    wm.failed += 1;
    ag.failed += 1;
  }

  _persistDeliveryMetrics(webhookId, { success, attempts, latencyMs });
}

function getMetrics() {
  const perWebhook = {};
  for (const [webhookId, m] of metrics._deliveries) {
    perWebhook[webhookId] = {
      total: m.total,
      success: m.success,
      failed: m.failed,
      success_rate:
        m.total > 0 ? parseFloat((m.success / m.total).toFixed(4)) : null,
      retry_rate:
        m.total > 0
          ? parseFloat(((m.totalAttempts - m.total) / m.total).toFixed(4))
          : null,
      avg_latency_ms:
        m.total > 0
          ? parseFloat((m.totalLatencyMs / m.total).toFixed(1))
          : null,
    };
  }
  const ag = metrics._aggregate;
  return {
    in_flight: metrics._inFlight.size,
    aggregate: {
      total: ag.total,
      success: ag.success,
      failed: ag.failed,
      success_rate:
        ag.total > 0 ? parseFloat((ag.success / ag.total).toFixed(4)) : null,
      retry_rate:
        ag.total > 0
          ? parseFloat(((ag.totalAttempts - ag.total) / ag.total).toFixed(4))
          : null,
      avg_latency_ms:
        ag.total > 0
          ? parseFloat((ag.totalLatencyMs / ag.total).toFixed(1))
          : null,
    },
    per_webhook: perWebhook,
  };
}

function getInFlightCount() {
  return metrics._inFlight.size;
}

function cacheWebhook(webhook) {
  if (!webhook) return;
  webhookCache.set(webhook.id, {
    value: Promise.resolve(webhook),
    expiresAt: Date.now() + WEBHOOK_CACHE_TTL_MS,
  });
}

async function getWebhookForAttempt(webhookId) {
  const now = Date.now();
  const cached = webhookCache.get(webhookId);
  if (cached && cached.expiresAt > now) return cached.value;
  if (cached) webhookCache.delete(webhookId);

  const entry = {
    value: webhookRepo.findById(webhookId),
    expiresAt: now + WEBHOOK_CACHE_TTL_MS,
  };
  webhookCache.set(webhookId, entry);
  try {
    const webhook = await entry.value;
    if (webhook) {
      entry.value = Promise.resolve(webhook);
      entry.expiresAt = Date.now() + WEBHOOK_CACHE_TTL_MS;
    } else {
      webhookCache.delete(webhookId);
    }
    return webhook;
  } catch (err) {
    webhookCache.delete(webhookId);
    throw err;
  }
}

/**
 * Computes the retry delay for a webhook delivery that has completed
 * `attemptsCompleted` attempts, using exponential backoff with "equal
 * jitter": half of the deterministic delay is fixed, the other half is
 * randomized within [0, half). This spreads out deliveries that fail at
 * the same attempt count around the same wall-clock moment — preventing
 * the synchronized-retry thundering-herd burst described in #128 — while
 * keeping the result always within [deterministic/2, deterministic):
 * never zero or negative, and never reaching or exceeding the original
 * deterministic delay, so worst-case retry latency stays predictable for
 * operators. "Full jitter" (uniformly random in [0, deterministic)) was
 * considered and rejected: it can produce near-immediate retries, and —
 * with the default 2x factor — its range for one attempt overlaps the
 * next attempt's range, which would make delays non-monotonic across
 * attempts.
 *
 * The random source is injectable via `options.random` (mirroring
 * CircuitBreaker's `options.now`/`options.logger` pattern in
 * `utils/circuitBreaker.js`) so tests can assert exact min/max bounds
 * rather than only "looks random".
 */
function backoffMs(attemptsCompleted, options = {}) {
  const random = options.random || Math.random;
  const base = config.webhooks.retryBaseMs;
  const factor = config.webhooks.retryFactor;
  const deterministicDelay = base * factor ** (attemptsCompleted - 1);
  const half = deterministicDelay / 2;
  return half + random() * half;
}

function shouldRetry(responseStatus, networkError) {
  if (networkError) return true;
  if (responseStatus == null) return true;
  if (responseStatus >= 500 && responseStatus < 600) return true;
  if (responseStatus === 408 || responseStatus === 429) return true;
  return false;
}

function buildHeaders(
  secret,
  body,
  eventType,
  deliveryId,
  requestId,
  sequence,
) {
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    "X-SmartDrop-Event": eventType,
    "X-SmartDrop-Delivery": deliveryId,
    "X-SmartDrop-Signature": signature.sign(secret, body),
  };
  if (sequence != null) headers["X-SmartDrop-Sequence"] = String(sequence);
  // Lets receivers correlate a delivery with the API request that caused
  // it when reporting problems back to us (issue #250).
  if (requestId) headers["X-Request-Id"] = requestId;
  return headers;
}

function generateDeliveryTraceId() {
  return `trace_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function matchesWebhookFilters(filters, data) {
  if (!filters) return true;
  if (!data || typeof data !== "object") return false;

  if (filters.asset !== undefined) {
    const asset =
      typeof data.asset === "string" ? data.asset.toUpperCase() : null;
    if (asset !== filters.asset) return false;
  }

  if (filters.pool_id !== undefined && data.pool_id !== filters.pool_id) {
    return false;
  }

  return true;
}

function withDeliveryTrace(traceId, fn) {
  const currentRequestId = requestContext.getStore()?.requestId;
  if (currentRequestId && currentRequestId !== "system") {
    return fn();
  }
  return requestContext.run({ requestId: traceId }, fn);
}

/**
 * #292 — Transient network errors (DNS blip, TCP reset, ECONNRESET) should
 * not immediately fail a delivery. Retry up to 2 additional times with
 * short exponential backoff before giving up to the caller, which has its
 * own retry/backoff layer. This only covers true network errors, not HTTP
 * error status codes (those are handled by the caller's shouldRetry logic).
 */
async function postOnce(url, headers, body, timeoutMs) {
  const maxAttempts = 3;
  const baseDelay = 200;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await axios.post(url, body, {
        headers,
        timeout: timeoutMs ?? config.webhooks.timeoutMs,
        transformRequest: [(data) => data],
        validateStatus: () => true,
        maxRedirects: 0,
      });
    } catch (err) {
      lastError = err;
      // Only retry on network errors, not HTTP errors (validateStatus catches those)
      if (attempt < maxAttempts) {
        const delay = baseDelay * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

async function attempt(deliveryId, sequence) {
  const delivery = await deliveryRepo.findById(deliveryId);
  if (!delivery) {
    logger.warn("Delivery missing, dropping retry", {
      delivery_id: deliveryId,
    });
    return null;
  }
  if (delivery.status === "success") return delivery;

  const traceId = delivery.trace_id || generateDeliveryTraceId();
  if (!delivery.trace_id) {
    await deliveryRepo.update(deliveryId, { trace_id: traceId });
  }

  return withDeliveryTrace(traceId, async () => {
    const webhook = await getWebhookForAttempt(delivery.webhook_id);
    if (!webhook || !webhook.active) {
      return deliveryRepo.update(deliveryId, {
        status: "failed",
        last_error: "webhook missing or inactive",
        last_attempt_at: new Date().toISOString(),
        next_retry_at: null,
      });
    }

    const payload = delivery.payload || {
      event: delivery.event_type,
      event_id: delivery.event_id,
      delivery_id: delivery.id,
      occurred_at: delivery.created_at,
    };
    const body = JSON.stringify(payload);
    const seq = sequence ?? delivery.sequence;
    const headers = buildHeaders(
      webhook.secret,
      body,
      delivery.event_type,
      delivery.id,
      delivery.request_id,
      seq,
    );

    const attempts = delivery.attempts + 1;
    let responseStatus = null;
    let networkError = null;

    const deliveryStartTime = Date.now();
    recordDeliveryStart(deliveryId, webhook.id);

    try {
      await assertPublicTarget(webhook.url);
      const res = await postOnce(webhook.url, headers, body, webhook.timeoutMs);
      responseStatus = res.status;
    } catch (err) {
      networkError = err.message || "network error";
    }

    const succeeded =
      responseStatus != null && responseStatus >= 200 && responseStatus < 300;
    const nowIso = new Date().toISOString();
    const latencyMs = Date.now() - deliveryStartTime;

    // Metrics will be finalized after we determine final status below

    if (succeeded) {
      recordDeliveryEnd(deliveryId, webhook.id, {
        success: true,
        attempts,
        latencyMs,
      });
      logger.info("Webhook delivered", {
        delivery_id: delivery.id,
        trace_id: traceId,
        request_id: delivery.request_id,
        webhook_id: webhook.id,
        attempts,
        status: responseStatus,
      });
      return deliveryRepo.update(deliveryId, {
        status: "success",
        attempts,
        last_attempt_at: nowIso,
        next_retry_at: null,
        last_error: null,
        response_status: responseStatus,
      });
    }

    const errorMessage = networkError || `HTTP ${responseStatus}`;
    const retryable = shouldRetry(responseStatus, Boolean(networkError));
    const hasAttemptsLeft = attempts < config.webhooks.maxAttempts;

    if (retryable && hasAttemptsLeft) {
      recordDeliveryEnd(deliveryId, webhook.id, {
        success: false,
        attempts,
        latencyMs,
      });
      const delayMs = backoffMs(attempts);
      const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
      await deliveryRepo.scheduleRetry(delivery.id, Date.now() + delayMs);
      logger.warn("Webhook delivery failed, retry scheduled", {
        delivery_id: delivery.id,
        trace_id: traceId,
        request_id: delivery.request_id,
        webhook_id: webhook.id,
        attempts,
        error: errorMessage,
        next_retry_at: nextRetryAt,
      });
      return deliveryRepo.update(deliveryId, {
        status: "pending",
        attempts,
        last_attempt_at: nowIso,
        next_retry_at: nextRetryAt,
        last_error: errorMessage,
        response_status: responseStatus,
      });
    }

    recordDeliveryEnd(deliveryId, webhook.id, {
      success: false,
      attempts,
      latencyMs,
    });
    logger.error("Webhook delivery failed permanently", {
      delivery_id: delivery.id,
      trace_id: traceId,
      request_id: delivery.request_id,
      webhook_id: webhook.id,
      attempts,
      error: errorMessage,
    });

    // #289 — Move permanently failed deliveries to a dead letter queue so
    // they can be inspected, manually retried, or alerting-triggered without
    // cluttering the active delivery table.
    try {
      const redis = cache.getClient();
      const deadLetterEntry = JSON.stringify({
        delivery_id: delivery.id,
        webhook_id: webhook.id,
        event_type: delivery.event_type,
        event_id: delivery.event_id,
        error: errorMessage,
        response_status: responseStatus,
        attempts,
        failed_at: nowIso,
        trace_id: traceId,
        request_id: delivery.request_id,
      });
      await redis.lpush("webhook:dead_letter", deadLetterEntry);
      // Cap the dead letter queue at 10,000 entries to prevent unbounded growth
      await redis.ltrim("webhook:dead_letter", 0, 9999);
    } catch (dlqErr) {
      logger.warn("Failed to enqueue dead letter", {
        delivery_id: delivery.id,
        error: dlqErr.message,
      });
    }

    return deliveryRepo.update(deliveryId, {
      status: "failed",
      attempts,
      last_attempt_at: nowIso,
      next_retry_at: null,
      last_error: errorMessage,
      response_status: responseStatus,
    });
  });
}

async function deliverToWebhook(
  webhook,
  eventType,
  eventId,
  payload,
  sequence,
) {
  cacheWebhook(webhook);
  // Propagate the originating request's id onto the delivery record so a
  // webhook that fires hours later on a retry is still traceable back to
  // the API call that caused it (issue #250).
  const requestId = requestContext.getStore()?.requestId;
  const delivery = await deliveryRepo.create({
    webhook_id: webhook.id,
    event_id: eventId,
    event_type: eventType,
    request_id: requestId && requestId !== "system" ? requestId : null,
  });
  await deliveryRepo.update(delivery.id, { payload, sequence });
  return attempt(delivery.id, sequence);
}

const DISPATCH_CONCURRENCY =
  parseInt(process.env.WEBHOOK_DISPATCH_CONCURRENCY, 10) || 10;
const ORDERED_DELIVERY = process.env.WEBHOOK_ORDERED_DELIVERY === "true";
const MAX_IN_FLIGHT = parseInt(process.env.WEBHOOK_MAX_IN_FLIGHT, 10) || 100;

class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
  }

  release() {
    this.current--;
    const next = this.queue.shift();
    if (next) {
      this.current++;
      next();
    }
  }
}

const deliverySemaphore = new Semaphore(MAX_IN_FLIGHT);

async function deliverWithLimit(
  webhook,
  eventType,
  eventId,
  payload,
  sequence,
) {
  await deliverySemaphore.acquire();
  try {
    return await deliverToWebhook(
      webhook,
      eventType,
      eventId,
      payload,
      sequence,
    );
  } finally {
    deliverySemaphore.release();
  }
}

async function processBatch(batch, eventType, eventId, payload, sequence) {
  if (ORDERED_DELIVERY) {
    const results = [];
    for (const webhook of batch) {
      try {
        const value = await deliverWithLimit(
          webhook,
          eventType,
          eventId,
          payload,
          sequence,
        );
        results.push({ status: "fulfilled", value });
      } catch (reason) {
        results.push({ status: "rejected", reason });
      }
    }
    return results;
  }
  return Promise.allSettled(
    batch.map((webhook) =>
      deliverWithLimit(webhook, eventType, eventId, payload, sequence),
    ),
  );
}

async function dispatch({ event_type: eventType, event_id: eventId, data }) {
  if (!events.isKnownEvent(eventType)) {
    logger.warn("Dispatch skipped, unknown event type", {
      event_type: eventType,
    });
    return [];
  }
  if (!eventId || typeof eventId !== "string") {
    throw new Error("event_id is required to dispatch a webhook event");
  }

  const traceId = generateDeliveryTraceId();
  return withDeliveryTrace(traceId, async () => {
    const dedupKey = `webhook:dispatched:${eventId}`;
    // Use SET NX (set-if-not-exists) to claim the dedup slot atomically before
    // dispatching. The previous flow checked then set, allowing concurrent calls
    // with the same event_id to both pass the dedup check (#283).
    // TTL of 7776000 seconds (90 days) prevents re-dispatch of old events (#405).
    const alreadyDispatched = await cache
      .getClient()
      .set(dedupKey, Date.now(), "EX", 7776000, "NX");
    if (!alreadyDispatched) {
      logger.info("Skipping duplicate webhook dispatch", {
        event_id: eventId,
        event_type: eventType,
        trace_id: traceId,
      });
      return [];
    }

    const targets = (
      await webhookRepo.listActiveForEvent(
        eventType,
        events.matchesSubscription,
      )
    ).filter((webhook) => matchesWebhookFilters(webhook.filters, data));
    if (targets.length === 0) {
      logger.info("Dispatch started, no matching webhooks", {
        event_id: eventId,
        event_type: eventType,
        trace_id: traceId,
      });
      return [];
    }

    logger.info("Dispatch started", {
      event_id: eventId,
      event_type: eventType,
      trace_id: traceId,
      target_count: targets.length,
    });

    const resourceId = data?.pool_id || data?.asset || eventType;
    const redis = cache.getClient();
    const sequence = await redis.incr(`seq:${resourceId}`);

    const occurredAt = new Date().toISOString();
    const payload = {
      event: eventType,
      event_id: eventId,
      occurred_at: occurredAt,
      sequence,
      data: data || {},
    };

    const allResults = [];
    for (let i = 0; i < targets.length; i += DISPATCH_CONCURRENCY) {
      const batch = targets.slice(i, i + DISPATCH_CONCURRENCY);
      const batchResults = await processBatch(
        batch,
        eventType,
        eventId,
        payload,
        sequence,
      );
      allResults.push(...batchResults);
    }

    const successCount = allResults.filter(
      (r) => r.status === "fulfilled",
    ).length;
    const failureCount = allResults.filter(
      (r) => r.status === "rejected",
    ).length;

    logger.info("Dispatch completed", {
      event_id: eventId,
      event_type: eventType,
      trace_id: traceId,
      success_count: successCount,
      failure_count: failureCount,
    });

    return allResults.map((result, i) => {
      const webhook_id = targets[i].id;
      if (result.status === "fulfilled") {
        return { webhook_id, delivery: result.value, error: null };
      }
      logger.warn("Webhook delivery failed at dispatch", {
        webhook_id,
        event_id: eventId,
        trace_id: traceId,
        error: result.reason?.message || String(result.reason),
      });
      return {
        webhook_id,
        delivery: null,
        error: result.reason?.message || String(result.reason),
      };
    });
  });
}

async function sendTest(webhookId) {
  const webhook = await webhookRepo.findById(webhookId);
  if (!webhook) return null;
  // Re-validate at test time (not just at create time, see ssrfGuard's
  // module doc for why): a hostname can be re-pointed after registration,
  // and a raw private IP could have been seeded directly (#96).
  await assertPublicTarget(webhook.url);
  const eventType = "pool.assets_locked";
  const payload = {
    event: eventType,
    event_id: `evt_test_${Date.now()}`,
    occurred_at: new Date().toISOString(),
    data: { test: true, message: "This is a test delivery from SmartDrop" },
  };
  return deliverToWebhook(webhook, eventType, payload.event_id, payload, null);
}

module.exports = {
  dispatch,
  attempt,
  sendTest,
  backoffMs,
  shouldRetry,
  getMetrics,
  getInFlightCount,
  hydrateMetrics,
  recordDeliveryStart,
  recordDeliveryEnd,
};
