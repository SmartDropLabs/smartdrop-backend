'use strict';

const config = require('../config');
const logger = require('../logger');
const dispatcher = require('../services/webhookDispatcher');
const deliveryRepo = require('../repositories/deliveryRepository');

let timer = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const ids = await deliveryRepo.popDueRetries(Date.now(), config.webhooks.retryBatchSize);
    if (ids.length === 0) return;
    logger.info('Processing webhook retries', { count: ids.length });
    for (const id of ids) {
      try {
        await dispatcher.attempt(id);
      } catch (err) {
        logger.error('Retry attempt failed', { delivery_id: id, error: err.message });
      }
    }
  } catch (err) {
    logger.error('Webhook retry worker tick failed', { error: err.message });
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  const interval = config.webhooks.retryPollMs;
  timer = setInterval(tick, interval);
  if (typeof timer.unref === 'function') timer.unref();
  logger.info('Webhook retry worker started', { intervalMs: interval });
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Webhook retry worker stopped');
  }
}

module.exports = { start, stop, tick };
