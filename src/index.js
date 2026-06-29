'use strict';

const express = require('express');
const helmet = require('helmet');
const config = require('./config');
const logger = require('./logger');
const cache = require('./services/cache');
const priceRefreshJob = require('./jobs/priceRefresh');
const webhookRetryWorker = require('./jobs/webhookRetryWorker');
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

const app = express();
let server;

app.use(requestIdMiddleware);
app.use(helmet());
app.use(buildCorsMiddleware(config.corsAllowedOrigins));
app.use(express.json());

app.get('/health', (req, res) => {
  const redisConnected = cache.isConnected();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    redis_connected: redisConnected,
    redis_unavailable: !redisConnected,
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
    if (server) server.close();
    await cache.disconnect();
    process.exit(0);
  };
}

if (require.main === module) {
  server = app.listen(config.port, () => {
    logger.info(`SmartDrop backend running on port ${config.port}`);
    priceRefreshJob.start();
    webhookRetryWorker.start();
  });

  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));
}

module.exports = app;
module.exports.app = app;
module.exports.server = server || {
  close(callback) {
    if (callback) callback();
  },
};
