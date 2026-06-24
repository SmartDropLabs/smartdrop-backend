const express = require('express');
const cors = require('cors');
const config = require('./config');
const logger = require('./logger');
const cache = require('./services/cache');
const priceRefreshJob = require('./jobs/priceRefresh');
const pricesRouter = require('./routes/prices');
const alertsRouter = require('./routes/alerts');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/v1', pricesRouter);
app.use('/api/v1', alertsRouter);

app.use((err, req, res, _next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(config.port, () => {
  logger.info(`SmartDrop backend running on port ${config.port}`);
  priceRefreshJob.start();
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down');
  priceRefreshJob.stop();
  server.close();
  await cache.disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down');
  priceRefreshJob.stop();
  server.close();
  await cache.disconnect();
  process.exit(0);
});

module.exports = app;
