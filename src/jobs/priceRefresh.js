const cron = require('node-cron');
const priceOracle = require('../services/priceOracle');
const alertsService = require('../services/alerts');
const subscriptionManager = require('../ws/PriceSubscriptionManager');
const config = require('../config');
const logger = require('../logger');

let scheduledTask = null;

const health = {
  startedAt: null,
  lastSuccessAt: null,
  lastError: null,
  running: false,
};

function start() {
  const intervalSeconds = config.price.refreshInterval;
  const cronExpression = `*/${intervalSeconds} * * * * *`;
  health.startedAt = Date.now();

  scheduledTask = cron.schedule(cronExpression, async () => {
    try {
      logger.info('Starting scheduled price refresh');
      const freshPrices = await priceOracle.refreshAllCachedPrices();
      await alertsService.evaluateAll();
      if (freshPrices && Object.keys(freshPrices).length > 0) {
        subscriptionManager.notifyPriceUpdates(freshPrices);
      }
      health.lastSuccessAt = Date.now();
      health.lastError = null;
    } catch (err) {
      logger.error('Scheduled price refresh failed', { error: err.message });
      health.lastError = err.message;
    }
  }, {
    scheduled: true,
  });

  logger.info('Price refresh job started', { intervalSeconds });
}

function stop() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    health.startedAt = null;
    logger.info('Price refresh job stopped');
  }
}

/**
 * Returns the current health state of the price-refresh job.
 *
 * Grace period: a job that has never run since startup is not considered
 * stalled until at least one full interval has elapsed.
 *
 * @returns {{ healthy: boolean, lastSuccessAt: number|null, lastError: string|null, stalled: boolean }}
 */
function getHealth() {
  if (!health.startedAt) {
    return { healthy: false, lastSuccessAt: null, lastError: null, stalled: false };
  }

  const intervalMs = (config.price.refreshInterval || 30) * 1000;
  // Grace period: allow 2× the interval before flagging as stalled
  const gracePeriodMs = intervalMs * 2;
  const age = Date.now() - health.startedAt;
  const inGrace = age < gracePeriodMs;

  if (health.lastSuccessAt === null) {
    // Has not run yet — only healthy while inside the grace window
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

module.exports = { start, stop, getHealth };
