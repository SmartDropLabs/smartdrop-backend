'use strict';

const config = require('../config');
const logger = require('../logger');
const dispatcher = require('../services/webhookDispatcher');
const deliveryRepo = require('../repositories/deliveryRepository');

let timer = null;
let running = false;

const health = {
  startedAt: null,
  lastSuccessAt: null,
  lastError: null,
  // Queue-depth telemetry (issue #235): operators need to see retries
  // backing up, not just that the worker is alive.
  lastBatchSize: null,
  totalRetriesProcessed: 0,
  totalRetryLatencyMs: 0,
};

async function tick() {
  if (running) return;
  running = true;
  try {
    const ids = await deliveryRepo.popDueRetries(Date.now(), config.webhooks.retryBatchSize);
    health.lastBatchSize = ids.length;
    if (ids.length === 0) {
      // An empty poll is still a successful tick
      health.lastSuccessAt = Date.now();
      health.lastError = null;
      return;
    }
    logger.info('Processing webhook retries', { count: ids.length });
    for (const id of ids) {
      const attemptStartedAt = Date.now();
      try {
        await dispatcher.attempt(id);
      } catch (err) {
        logger.error('Retry attempt failed', { delivery_id: id, error: err.message });
      }
      // Latency is recorded for failed attempts too — a retry that times
      // out is exactly the case where the average matters most.
      health.totalRetriesProcessed += 1;
      health.totalRetryLatencyMs += Date.now() - attemptStartedAt;
    }
    health.lastSuccessAt = Date.now();
    health.lastError = null;
  } catch (err) {
    logger.error('Webhook retry worker tick failed', { error: err.message });
    health.lastError = err.message;
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  const interval = config.webhooks.retryPollMs;
  health.startedAt = Date.now();
  timer = setInterval(tick, interval);
  if (typeof timer.unref === 'function') timer.unref();
  logger.info('Webhook retry worker started', { intervalMs: interval });
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    health.startedAt = null;
    logger.info('Webhook retry worker stopped');
  }
}

/**
 * Returns the current health state of the webhook retry worker.
 *
 * Grace period: allow 2× the poll interval before flagging as stalled.
 *
 * @returns {{ healthy: boolean, lastSuccessAt: number|null, lastError: string|null, stalled: boolean, lastBatchSize: number|null, avgDeliveryLatencyMs: number|null }}
 */
function getHealth() {
  const throughput = {
    lastBatchSize: health.lastBatchSize,
    avgDeliveryLatencyMs: health.totalRetriesProcessed > 0
      ? Math.round((health.totalRetryLatencyMs / health.totalRetriesProcessed) * 10) / 10
      : null,
  };

  if (!health.startedAt) {
    return { healthy: false, lastSuccessAt: null, lastError: null, stalled: false, ...throughput };
  }

  const intervalMs = (config.webhooks.retryPollMs || 5000);
  const gracePeriodMs = intervalMs * 2;
  const age = Date.now() - health.startedAt;
  const inGrace = age < gracePeriodMs;

  if (health.lastSuccessAt === null) {
    return { healthy: inGrace, lastSuccessAt: null, lastError: health.lastError, stalled: !inGrace, ...throughput };
  }

  const timeSinceSuccess = Date.now() - health.lastSuccessAt;
  const stalled = timeSinceSuccess > gracePeriodMs;
  return {
    healthy: !stalled,
    lastSuccessAt: health.lastSuccessAt,
    lastError: health.lastError,
    stalled,
    ...throughput,
  };
}

/**
 * Queue-depth snapshot for the /health endpoint (issue #235).
 *
 * Separate from `getHealth()` because it needs a Redis round trip, and
 * `getHealth()` is called synchronously from the leader-aware wrapper.
 * Returns `pendingRetries: null` when Redis is unreachable so the health
 * endpoint can distinguish "no retries queued" from "cannot tell".
 */
async function getQueueStats() {
  return {
    pendingRetries: await deliveryRepo.countPendingRetries(),
    lastBatchSize: health.lastBatchSize,
    avgDeliveryLatencyMs: health.totalRetriesProcessed > 0
      ? Math.round((health.totalRetryLatencyMs / health.totalRetriesProcessed) * 10) / 10
      : null,
    totalRetriesProcessed: health.totalRetriesProcessed,
  };
}

module.exports = { start, stop, tick, getHealth, getQueueStats };
