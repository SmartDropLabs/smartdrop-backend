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
};

async function tick() {
  if (running) return;
  running = true;
  try {
    const ids = await deliveryRepo.popDueRetries(Date.now(), config.webhooks.retryBatchSize);
    if (ids.length === 0) {
      // An empty poll is still a successful tick
      health.lastSuccessAt = Date.now();
      health.lastError = null;
      return;
    }
    logger.info('Processing webhook retries', { count: ids.length });
    for (const id of ids) {
      try {
        await dispatcher.attempt(id);
      } catch (err) {
        logger.error('Retry attempt failed', { delivery_id: id, error: err.message });
      }
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
 * @returns {{ healthy: boolean, lastSuccessAt: number|null, lastError: string|null, stalled: boolean }}
 */
function getHealth() {
  if (!health.startedAt) {
    return { healthy: false, lastSuccessAt: null, lastError: null, stalled: false };
  }

  const intervalMs = (config.webhooks.retryPollMs || 5000);
  const gracePeriodMs = intervalMs * 2;
  const age = Date.now() - health.startedAt;
  const inGrace = age < gracePeriodMs;

  if (health.lastSuccessAt === null) {
    return { healthy: inGrace, lastSuccessAt: null, lastError: health.lastError, stalled: !inGrace };
  }

  const timeSinceSuccess = Date.now() - health.lastSuccessAt;
  const stalled = timeSinceSuccess > gracePeriodMs;
  return {
    healthy: !stalled,
    lastSuccessAt: health.lastSuccessAt,
    lastError: health.lastError,
    stalled,
  };
}

module.exports = { start, stop, tick, getHealth };
