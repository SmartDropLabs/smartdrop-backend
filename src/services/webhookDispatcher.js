'use strict';

const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');
const logger = require('../logger');
const cache = require('./cache');
const signature = require('./webhookSignature');
const events = require('./webhookEvents');
const webhookRepo = require('../repositories/webhookRepository');
const deliveryRepo = require('../repositories/deliveryRepository');
const { requestContext } = require('../middleware/requestId');

const USER_AGENT = 'SmartDrop-Webhooks/1.0';

const DLQ_KEY = 'webhook:dlq';
const DLQ_ENTRY_PREFIX = 'webhook:dlq:entry:';
const DLQ_TTL_SECONDS = parseInt(process.env.WEBHOOK_DLQ_TTL_SECONDS, 10) || 7 * 24 * 60 * 60;

// ── Delivery metrics (in-memory, reset on process restart) ──────────────
const metrics = {
  _deliveries: new Map(), // webhook_id → { total, success, failed, totalAttempts, totalLatencyMs }
  _inFlight: new Set(),   // delivery IDs currently being attempted
  _aggregate: { total: 0, success: 0, failed: 0, totalAttempts: 0, totalLatencyMs: 0 },
};

function _ensureWebhookMetrics(webhookId) {
  if (!metrics._deliveries.has(webhookId)) {
    metrics._deliveries.set(webhookId, {
      total: 0, success: 0, failed: 0, totalAttempts: 0, totalLatencyMs: 0,
    });
  }
  return metrics._deliveries.get(webhookId);
}

function recordDeliveryStart(deliveryId, webhookId) {
  metrics._inFlight.add(deliveryId);
  _ensureWebhookMetrics(webhookId);
}

function recordDeliveryEnd(deliveryId, webhookId, { success, attempts, latencyMs }) {
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
}

function getMetrics() {
  const perWebhook = {};
  for (const [webhookId, m] of metrics._deliveries) {
    perWebhook[webhookId] = {
      total: m.total,
      success: m.success,
      failed: m.failed,
      success_rate: m.total > 0 ? parseFloat((m.success / m.total).toFixed(4)) : null,
      retry_rate: m.total > 0 ? parseFloat(((m.totalAttempts - m.total) / m.total).toFixed(4)) : null,
      avg_latency_ms: m.total > 0 ? parseFloat((m.totalLatencyMs / m.total).toFixed(1)) : null,
    };
  }
  const ag = metrics._aggregate;
  return {
    in_flight: metrics._inFlight.size,
    aggregate: {
      total: ag.total,
      success: ag.success,
      failed: ag.failed,
      success_rate: ag.total > 0 ? parseFloat((ag.success / ag.total).toFixed(4)) : null,
      retry_rate: ag.total > 0 ? parseFloat(((ag.totalAttempts - ag.total) / ag.total).toFixed(4)) : null,
      avg_latency_ms: ag.total > 0 ? parseFloat((ag.totalLatencyMs / ag.total).toFixed(1)) : null,
    },
    per_webhook: perWebhook,
  };
}

function getInFlightCount() {
  return metrics._inFlight.size;
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

function buildHeaders(secret, body, eventType, deliveryId, requestId, sequence) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    'X-SmartDrop-Event': eventType,
    'X-SmartDrop-Delivery': deliveryId,
    'X-SmartDrop-Signature': signature.sign(secret, body),
  };
  if (sequence != null) headers['X-SmartDrop-Sequence'] = String(sequence);
  // Lets receivers correlate a delivery with the API request that caused
  // it when reporting problems back to us (issue #250).
  if (requestId) headers['X-Request-Id'] = requestId;
  return headers;
}

function generateDeliveryTraceId() {
  return `trace_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

function matchesWebhookFilters(filters, data) {
  if (!filters) return true;
  if (!data || typeof data !== 'object') return false;

  if (filters.asset !== undefined) {
    const asset = typeof data.asset === 'string' ? data.asset.toUpperCase() : null;
    if (asset !== filters.asset) return false;
  }

  if (filters.pool_id !== undefined && data.pool_id !== filters.pool_id) {
    return false;
  }

  return true;
}

function withDeliveryTrace(traceId, fn) {
  const currentRequestId = requestContext.getStore()?.requestId;
  if (currentRequestId && currentRequestId !== 'system') {
    return fn();
  }
  return requestContext.run({ requestId: traceId }, fn);
}

async function postOnce(url, headers, body, timeoutMs) {
  return axios.post(url, body, {
    headers,
    timeout: timeoutMs ?? config.webhooks.timeoutMs,
    transformRequest: [(data) => data],
    validateStatus: () => true,
    maxRedirects: 0,
  });
}

async function attempt(deliveryId, sequence) {
  const delivery = await deliveryRepo.findById(deliveryId);
  if (!delivery) {
    logger.warn('Delivery missing, dropping retry', { delivery_id: deliveryId });
    return null;
  }
  if (delivery.status === 'success') return delivery;

  const traceId = delivery.trace_id || generateDeliveryTraceId();
  if (!delivery.trace_id) {
    await deliveryRepo.update(deliveryId, { trace_id: traceId });
  }

  return withDeliveryTrace(traceId, async () => {
    const webhook = await webhookRepo.findById(delivery.webhook_id);
    if (!webhook || !webhook.active) {
      const nowIso = new Date().toISOString();
      const updated = await deliveryRepo.update(deliveryId, {
        status: 'failed',
        last_error: 'webhook missing or inactive',
        last_attempt_at: nowIso,
        next_retry_at: null,
      });
      await _enqueueDeadLetter(delivery, webhook, {
        attempts: delivery.attempts || 0,
        error: 'webhook missing or inactive',
        at: nowIso,
        responseStatus: null,
        traceId: delivery.trace_id,
        requestId: delivery.request_id,
      });
      return updated;
    }

    const payload = delivery.payload || {
      event: delivery.event_type,
      event_id: delivery.event_id,
      delivery_id: delivery.id,
      occurred_at: delivery.created_at,
    };
    const body = JSON.stringify(payload);
    const seq = sequence ?? delivery.sequence;
    const headers = buildHeaders(webhook.secret, body, delivery.event_type, delivery.id, delivery.request_id, seq);

    const attempts = delivery.attempts + 1;
    let responseStatus = null;
    let networkError = null;

    const deliveryStartTime = Date.now();
    recordDeliveryStart(deliveryId, webhook.id);

    try {
      const res = await postOnce(webhook.url, headers, body, webhook.timeoutMs);
      responseStatus = res.status;
    } catch (err) {
      networkError = err.message || 'network error';
    }

    const succeeded = responseStatus != null && responseStatus >= 200 && responseStatus < 300;
    const nowIso = new Date().toISOString();
    const latencyMs = Date.now() - deliveryStartTime;

    // Metrics will be finalized after we determine final status below

    if (succeeded) {
      recordDeliveryEnd(deliveryId, webhook.id, { success: true, attempts, latencyMs });
      logger.info('Webhook delivered', {
        delivery_id: delivery.id,
        trace_id: traceId,
        request_id: delivery.request_id,
        webhook_id: webhook.id,
        attempts,
        status: responseStatus,
      });
      return deliveryRepo.update(deliveryId, {
        status: 'success',
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
      recordDeliveryEnd(deliveryId, webhook.id, { success: false, attempts, latencyMs });
      const delayMs = backoffMs(attempts);
      const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
      await deliveryRepo.scheduleRetry(delivery.id, Date.now() + delayMs);
      logger.warn('Webhook delivery failed, retry scheduled', {
        delivery_id: delivery.id,
        trace_id: traceId,
        request_id: delivery.request_id,
        webhook_id: webhook.id,
        attempts,
        error: errorMessage,
        next_retry_at: nextRetryAt,
      });
      return deliveryRepo.update(deliveryId, {
        status: 'pending',
        attempts,
        last_attempt_at: nowIso,
        next_retry_at: nextRetryAt,
        last_error: errorMessage,
        response_status: responseStatus,
      });
    }

    recordDeliveryEnd(deliveryId, webhook.id, { success: false, attempts, latencyMs });
    logger.error('Webhook delivery failed permanently', {
      delivery_id: delivery.id,
      trace_id: traceId,
      request_id: delivery.request_id,
      webhook_id: webhook.id,
      attempts,
      error: errorMessage,
    });
    const updated = await deliveryRepo.update(deliveryId, {
      status: 'failed',
      attempts,
      last_attempt_at: nowIso,
      next_retry_at: null,
      last_error: errorMessage,
      response_status: responseStatus,
    });
    await _enqueueDeadLetter(delivery, webhook, {
      attempts,
      error: errorMessage,
      at: nowIso,
      responseStatus,
      traceId,
      requestId: delivery.request_id,
    });
    return updated;
  });
}

async function deliverToWebhook(webhook, eventType, eventId, payload, sequence) {
  // Propagate the originating request's id onto the delivery record so a
  // webhook that fires hours later on a retry is still traceable back to
  // the API call that caused it (issue #250).
  const requestId = requestContext.getStore()?.requestId;
  const delivery = await deliveryRepo.create({
    webhook_id: webhook.id,
    event_id: eventId,
    event_type: eventType,
    request_id: requestId && requestId !== 'system' ? requestId : null,
  });
  await deliveryRepo.update(delivery.id, { payload, sequence });
  return attempt(delivery.id, sequence);
}

const DISPATCH_CONCURRENCY = parseInt(process.env.WEBHOOK_DISPATCH_CONCURRENCY, 10) || 10;
const ORDERED_DELIVERY = process.env.WEBHOOK_ORDERED_DELIVERY === 'true';

async function processBatch(batch, eventType, eventId, payload, sequence) {
  if (ORDERED_DELIVERY) {
    const results = [];
    for (const webhook of batch) {
      try {
        const value = await deliverToWebhook(webhook, eventType, eventId, payload, sequence);
        results.push({ status: 'fulfilled', value });
      } catch (reason) {
        results.push({ status: 'rejected', reason });
      }
    }
    return results;
  }
  return Promise.allSettled(
    batch.map((webhook) => deliverToWebhook(webhook, eventType, eventId, payload, sequence))
  );
}

async function dispatch({ event_type: eventType, event_id: eventId, data }) {
  if (!events.isKnownEvent(eventType)) {
    logger.warn('Dispatch skipped, unknown event type', { event_type: eventType });
    return [];
  }
  if (!eventId || typeof eventId !== 'string') {
    throw new Error('event_id is required to dispatch a webhook event');
  }

  const dedupKey = `webhook:dispatched:${eventId}`;
  const alreadyDispatched = await cache.get(dedupKey);
  if (alreadyDispatched) {
    logger.info('Skipping duplicate webhook dispatch', { event_id: eventId, event_type: eventType });
    return [];
  }

  const targets = (await webhookRepo.listActiveForEvent(eventType, events.matchesSubscription))
    .filter((webhook) => matchesWebhookFilters(webhook.filters, data));
  if (targets.length === 0) return [];

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
    const batchResults = await processBatch(batch, eventType, eventId, payload, sequence);
    allResults.push(...batchResults);
  }

  await cache.set(dedupKey, Date.now(), 86400);

  return allResults.map((result, i) => {
    const webhook_id = targets[i].id;
    if (result.status === 'fulfilled') {
      return { webhook_id, delivery: result.value, error: null };
    }
    logger.error('Webhook delivery failed', { webhook_id, error: result.reason?.message || String(result.reason) });
    return { webhook_id, delivery: null, error: result.reason?.message || String(result.reason) };
  });
}

async function sendTest(webhookId) {
  const webhook = await webhookRepo.findById(webhookId);
  if (!webhook) return null;
  const eventType = 'pool.assets_locked';
  const payload = {
    event: eventType,
    event_id: `evt_test_${Date.now()}`,
    occurred_at: new Date().toISOString(),
    data: { test: true, message: 'This is a test delivery from SmartDrop' },
  };
  return deliverToWebhook(webhook, eventType, payload.event_id, payload, null);
}
async function _enqueueDeadLetter(delivery, webhook, { attempts, error, at, responseStatus, traceId, requestId }) {
  try {
    const errorHistory = Array.isArray(delivery.error_history) ? delivery.error_history.slice() : [];
    if (errorHistory.length === 0 && delivery.last_error && delivery.last_attempt_at) {
      errorHistory.push({ attempt: delivery.attempts || 0, error: delivery.last_error, at: delivery.last_attempt_at, response_status: delivery.response_status || null });
    }
    errorHistory.push({ attempt: attempts, error, at, response_status: responseStatus });

    const entry = {
      id: delivery.id,
      webhook_id: delivery.webhook_id,
      event_id: delivery.event_id,
      event_type: delivery.event_type,
      request_id: requestId || delivery.request_id || null,
      sequence: delivery.sequence != null ? delivery.sequence : null,
      trace_id: traceId || delivery.trace_id || null,
      webhook_url: webhook?.url || null,
      payload: delivery.payload || { event: delivery.event_type, event_id: delivery.event_id, delivery_id: delivery.id, occurred_at: delivery.created_at },
      attempts,
      response_status: responseStatus,
      last_error: error,
      error_history: errorHistory,
      failed_at: at,
    };

    const redis = cache.getClient();
    await redis.set(`${DLQ_ENTRY_PREFIX}${delivery.id}`, JSON.stringify(entry), 'EX', DLQ_TTL_SECONDS);
    await redis.zadd(DLQ_KEY, Date.now(), delivery.id);
  } catch (err) {
    logger.error('Failed to add webhook delivery to DLQ', { delivery_id: delivery.id, error: err.message });
  }
}

async function listDeadLetterQueue({ start = 0, stop = -1 } = {}) {
  const redis = cache.getClient();
  await redis.zremrangebyscore(DLQ_KEY, '-inf', Date.now() - DLQ_TTL_SECONDS * 1000);
  const items = await redis.zrange(DLQ_KEY, start, stop, 'WITHSCORES');
  const entries = [];
  for (let i = 0; i < items.length; i += 2) {
    const id = items[i];
    const score = Number(items[i + 1]);
    const entryKey = `${DLQ_ENTRY_PREFIX}${id}`;
    const raw = await redis.get(entryKey);
    if (!raw) {
      await redis.zrem(DLQ_KEY, id);
      continue;
    }
    try {
      entries.push({ ...JSON.parse(raw), score });
    } catch (err) {
      logger.warn('Removing invalid DLQ entry', { delivery_id: id, error: err.message });
      await redis.zrem(DLQ_KEY, id);
      await redis.del(entryKey);
    }
  }
  return entries;
}

async function retryDeadLetter(deliveryId) {
  const redis = cache.getClient();
  const entryKey = `${DLQ_ENTRY_PREFIX}${deliveryId}`;
  const raw = await redis.get(entryKey);
  if (!raw) return null;

  let entry;
  try {
    entry = JSON.parse(raw);
  } catch (err) {
    await redis.zrem(DLQ_KEY, deliveryId);
    await redis.del(entryKey);
    throw err;
  }

  const webhook = await webhookRepo.findById(entry.webhook_id);
  if (!webhook) {
    await redis.zrem(DLQ_KEY, deliveryId);
    await redis.del(entryKey);
    throw new Error('Webhook not found');
  }

  const delivery = await deliverToWebhook(webhook, entry.event_type, entry.event_id, entry.payload, entry.sequence);
  await redis.zrem(DLQ_KEY, deliveryId);
  await redis.del(entryKey);
  return delivery;
}

module.exports = { dispatch, attempt, sendTest, backoffMs, shouldRetry, getMetrics, getInFlightCount, listDeadLetterQueue, retryDeadLetter };
