'use strict';

const express = require('express');
const helmet = require('helmet');
const config = require('./config');
const logger = require('./logger');
const cache = require('./services/cache');
const priceOracle = require('./services/priceOracle');
const priceRefreshJob = require('./jobs/priceRefresh');
const webhookRetryWorker = require('./jobs/webhookRetryWorker');
const airdropExpiryJob = require('./jobs/airdropExpiry');
const { warmCache } = require('./startup/cacheWarm');
const buildCorsMiddleware = require('./middleware/cors');
const { requestIdMiddleware } = require('./middleware/requestId');
const { requireApiKey } = require('./middleware/auth');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const pricesRouter = require('./routes/prices');
const alertsRouter = require('./routes/alerts');
const keysRouter = require('./routes/keys');
const webhooksRouter = require('./routes/webhooks');
const airdropsRouter = require('./routes/airdrops');
const apiDocsRouter = require('./routes/apiDocs');

const priceWebSocket = require('./ws/priceWebSocket');

const app = express();
let server;

app.use(requestIdMiddleware);
app.use(helmet());
app.use(buildCorsMiddleware(config.corsAllowedOrigins));
app.use(express.json());

app.get('/health', (req, res) => {
  const redisConnected = cache.isConnected();
  const priceRefreshHealth = priceRefreshJob.getHealth();
  const webhookWorkerHealth = webhookRetryWorker.getHealth();

  // Compute overall status:
  //   unhealthy – Redis is down, or a job is stalled past its grace period
  //   degraded  – a job has not yet run but is still within its startup grace period
  //   ok        – all dependencies healthy
  let status = 'ok';
  if (!redisConnected || !priceRefreshHealth.healthy || !webhookWorkerHealth.healthy) {
    // Distinguish between "never started" (degraded) vs outright stalled/down (unhealthy)
    const jobsDegraded =
      (!priceRefreshHealth.healthy && !priceRefreshHealth.stalled) ||
      (!webhookWorkerHealth.healthy && !webhookWorkerHealth.stalled);
    status = (!redisConnected || priceRefreshHealth.stalled || webhookWorkerHealth.stalled)
      ? 'unhealthy'
      : jobsDegraded ? 'degraded' : 'unhealthy';
  }

  res.json({
    status,
    timestamp: new Date().toISOString(),
    redis: {
      connected: redisConnected,
    },
    jobs: {
      price_refresh: {
        healthy: priceRefreshHealth.healthy,
        last_success_at: priceRefreshHealth.lastSuccessAt
          ? new Date(priceRefreshHealth.lastSuccessAt).toISOString()
          : null,
        last_error: priceRefreshHealth.lastError,
        stalled: priceRefreshHealth.stalled,
      },
      webhook_retry_worker: {
        healthy: webhookWorkerHealth.healthy,
        last_success_at: webhookWorkerHealth.lastSuccessAt
          ? new Date(webhookWorkerHealth.lastSuccessAt).toISOString()
          : null,
        last_error: webhookWorkerHealth.lastError,
        stalled: webhookWorkerHealth.stalled,
      },
    },
    database: {
      configured: true,
      checked: false,
      status: 'unused',
    },
    price_source_circuits: priceOracle.getSourceCircuitStates(),
  });
});

app.use('/api/v1', pricesRouter);
app.use('/api/v1', keysRouter);
app.use('/api/v1/alerts', requireApiKey());
app.use('/api/v1', alertsRouter);
app.use('/api/v1', webhooksRouter);
app.use('/api/v1', airdropsRouter);
app.use('/api-docs', apiDocsRouter);

app.use(notFoundHandler);
app.use(errorHandler);

function shutdown(signal) {
  return async () => {
    logger.info(`${signal} received, shutting down`);
    priceRefreshJob.stop();
    webhookRetryWorker.stop();
    airdropExpiryJob.stop();
    require('./ws/PriceSubscriptionManager').stopHeartbeat();
    if (server) server.close();
    await cache.disconnect();
    process.exit(0);
  };
}

if (require.main === module) {
  startServer().catch((err) => {
    logger.error('Startup failed', { error: err.message });
    process.exit(1);
  });

  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));
}

async function startServer() {
  await warmCache(config.watchedAssets);

  server = app.listen(config.port, () => {
    logger.info(`SmartDrop backend running on port ${config.port}`);
    priceWebSocket.attach(server);
    priceRefreshJob.start();
    webhookRetryWorker.start();
    airdropExpiryJob.start();
  });
  module.exports.server = server;

  return server;
}

module.exports = app;
module.exports.app = app;
module.exports.server = server || {
  close(callback) {
    if (callback) callback();
  },
};
module.exports.startServer = startServer;
