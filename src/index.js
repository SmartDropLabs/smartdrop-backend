const express = require('express');
const helmet = require('helmet');
const config = require('./config');
const logger = require('./logger');
const cache = require('./services/cache');
const priceRefreshJob = require('./jobs/priceRefresh');
const buildCorsMiddleware = require('./middleware/cors');
const { requestIdMiddleware } = require('./middleware/requestId');
const { requireApiKey } = require('./middleware/auth');
const pricesRouter = require('./routes/prices');
const alertsRouter = require('./routes/alerts');
const keysRouter = require('./routes/keys');
const webhooksRouter = require('./routes/webhooks');
const airdropsRouter = require('./routes/airdrops');

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

app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(status).json({ error: err.message || 'Internal server error' });
});

// 1. Declaramos la variable server aquí afuera usando let (para que tenga alcance global en el archivo)
let server;

if (require.main === module) {
  // 2. Aquí adentro solo la asignamos (quitamos el 'const')
let server;

if (require.main === module) {
  server = app.listen(config.port, () => {
    logger.info(`SmartDrop backend running on port ${config.port}`);
    priceRefreshJob.start();
  });

  process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down');
    priceRefreshJob.stop();
    if (server) server.close();
    await cache.disconnect();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.info('SIGINT received, shutting down');
    priceRefreshJob.stop();
    if (server) server.close();
    await cache.disconnect();
    process.exit(0);
  });
}

// 3. Ahora el export funcionará perfectamente, tanto si corre directo como en modo test
module.exports = { app, server };
module.exports = app;
module.exports.app = app;
module.exports.server = server || {
  close(callback) {
    if (callback) callback();
  },
};
