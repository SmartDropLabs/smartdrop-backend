use strict';

const config = require('../config');
const logger = require('../logger');
const dispatcher = require('../services/webhookDispatcher');
const deliveryRepo = require('../repositories/deliveryRepository');
const redis = require('redis');
const { promisify } = require('util');

const redisClient = redis.createClient(config.redis || {});
redisClient.on('error', (err) => {
  logger.error('Redis error', { error: err.message });
});
const redisZAdd = promisify(redisClient.zadd).bind(redisClient);
const redisZRangeByScore = promisify(redisClient.zrangebyscore).bind(redisClient);
const redisZRem = promisify(redisClient.zrem).bind(redisClient);
const redisZRemRangeByScore = promisify(redisClient.zremrangebyscore).bind(redisClient);
const redisZRange = promisify(redisClient.zrange).bind(redisClient);

const DL_KEY = 'webhook:dlq';
const DL_TTL_MS = config.webhooks.dlqTtlMs || 7 * 24 * 60 * 60 * 1000;
let timer = null;
let running = false;

const health = {
  startedAt: null,
  lastSuccessAt: null,
  lastError: null,
  lastBatchSize: null,
  totalRetriesProcessed: 0,
  totalRetryLatencyMs: 0,
};

async function addToDlq(delivery) {
  const entry = {
    id: delivery.id,
    payload: delivery.payload || null,
    targetUrl: delivery.targetUrl || delivery.target_url || delivery.url || null,
    attempts: delivery.attemptCount || delivery.attempt_count || 0,
    errorHistory: delivery.errorHistory || delivery.error_history || [],
    lastError: delivery.lastError || delivery.last_error || null,
    failedAt: Date.now(),
  };
  const member = JSON.stringify(entry);
  const score = Date.now() + DL_TTL_MS;
  await redisZAdd(DL_KEY, score, member);
}

async function cleanupDlq() {
  try {
    await redisZRemRangeByScore(DL_KEY, '-inf', Date.now());
  } catch (err) {
    logger.error('DLQ cleanup failed', { error: err.message });
  }
}

async function listDlq() {
  const now = Date.now();
  const members = await redisZRangeByScore(DL_KEY, now + 1, '+mf');
  return members.map((member) => JSON.parse(member));
}

async function retryDlq(id) {
  const now = Date.now();
  const members = await redisZRangeByScore(DL_KEY, now + 1, '+inf');
  const entry = members.map((member) => JSON.parse(member)).find((e) => e.id === id);
  if (!entry) {
    const error = new Error('DLQ entry not found');
    error.statusCode = 404;
    throw error;
  }
  await redisZRem(DL_KEY, JSON.stringify(entry));
  await dispatcher.attempt(id);
  return entry;
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const ids = await deliveryRepo.popDueRetries(Date.now(), config.webhooks.retryBatchSize);
    health.lastBatchSize = ids.length;
    if (ids.length === 0) {
      health.lastSuccessAt = Date.now();
      health.lastError = null;
      await cleanupDlq();
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
      // After an attempt, check if the delivery has permanently failed
      // and move it to the DLQ so it can be replayed later.
      try {
        const delivery = await deliveryRepo.get(id);
        if (delivery && delivery.status === 'failed') {
          await addToDlq(delivery);
        }
      } catch (err) {
        logger.error('Failed to inspect delivery for DLQ', { delivery_id: id, error: err.message });
      }
      health.totalRetriesProcessed += 1;
      health.totalRetryLatencyMs += Date.now() - attemptStartedAt;
    }
    health.lastSuccessAt = Date.now();
    health.lastError = null;
    await cleanupDlq();
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

module.exports = { start, stop, tick, getHealth, getQueueStats, listDlq, retryDlq };
