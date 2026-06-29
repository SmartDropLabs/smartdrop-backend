const cron = require('node-cron');
const priceOracle = require('../services/priceOracle');
const alertsService = require('../services/alerts');
const subscriptionManager = require('../ws/PriceSubscriptionManager');
const config = require('../config');
const logger = require('../logger');

let scheduledTask = null;

function start() {
  const intervalSeconds = config.price.refreshInterval;
  const cronExpression = `*/${intervalSeconds} * * * * *`;

  scheduledTask = cron.schedule(cronExpression, async () => {
    try {
      logger.info('Starting scheduled price refresh');
      const freshPrices = await priceOracle.refreshAllCachedPrices();
      await alertsService.evaluateAll();
      if (freshPrices && Object.keys(freshPrices).length > 0) {
        subscriptionManager.notifyPriceUpdates(freshPrices);
      }
    } catch (err) {
      logger.error('Scheduled price refresh failed', { error: err.message });
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
    logger.info('Price refresh job stopped');
  }
}

module.exports = { start, stop };
