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
const { createLeaderElection } = require('./services/leaderElection');
const { makeLeaderAwareJob } = require('./jobs/leaderAwareJob');
const { warmCache } = require('./startup/cacheWarm');
const buildCorsMiddleware = require('./middleware/cors');
const buildRateLimit = require('./middleware/rateLimit');
const { requestIdMiddleware } = require('./middleware/requestId');
const requestLoggerMiddleware = require('./middleware/requestLogger');
const { requireApiKey } = require('./middleware/auth');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { checkDatabase } = require('./services/dbHealth');
const pricesRouter = require('./routes/prices');
const alertsRouter = require('./routes/alerts');
const indexerRouter = require('./routes/indexer');
const indexerPoller = require('./indexer/runtime');
const keysRouter = require('./routes/keys');
const webhooksRouter = require('./routes/webhooks');
const airdropsRouter = require('./routes/airdrops');
const apiDocsRouter = require('./routes/apiDocs');
const { router: metricsRouter, requestMetricsMiddleware } = require('./routes/metrics');

const priceWebSocket = require('./ws/priceWebSocket');

// Wrap background jobs with leader-election coordination so that only one
// replica across the deployment runs each job at any given time.
// See README.md#leader-election for design, failover timing, and configuration.
const leaderElectionPriceRefresh = createLeaderElection('price_refresh');
const leaderElectionWebhookRetry = createLeaderElection('webhook_retry');
const leaderElectionAirdropExpiry = createLeaderElection('airdrop_expiry');

const wrappedPriceRefreshJob = makeLeaderAwareJob({
  job: priceRefreshJob,
  jobName: 'price_refresh',
  leaderElection: leaderElectionPriceRefresh,
  logger,
});

const wrappedWebhookRetryWorker = makeLeaderAwareJob({
  job: webhookRetryWorker,
  jobName: 'webhook_retry',
  leaderElection: leaderElectionWebhookRetry,
  logger,
});

const wrappedAirdropExpiryJob = makeLeaderAwareJob({
  job: airdropExpiryJob,
  jobName: 'airdrop_expiry',
  leaderElection: leaderElectionAirdropExpiry,
  logger,
});

const app = express();
let server = {
  close(callback) {
    if (callback) callback();
  },
};

app.use(requestIdMiddleware);
app.use(requestLoggerMiddleware);
app.use(requestMetricsMiddleware);
app.use(helmet());
app.use(buildCorsMiddleware(config.corsAllowedOrigins));
app.use(express.json({ limit: config.airdrops.jsonMaxBytes }));

app.get('/health', async (req, res) => {
  const redisConnected = cache.isConnected();
  const priceRefreshHealth = wrappedPriceRefreshJob.getHealth();
  const webhookWorkerHealth = wrappedWebhookRetryWorker.getHealth();
  const airdropExpiryHealth = wrappedAirdropExpiryJob.getHealth();
  const database = await checkDatabase();
  const wsHealth = priceWebSocket.getHealth();

  // Compute overall status:
  //   unhealthy – Redis is down, or a job is stalled past its grace period
  //   degraded  – a job has not yet run but is still within its startup grace period
  //   ok        – all dependencies healthy
  //
  // Note: a non-leader instance reports its jobs as not healthy (since they
  // aren't running locally), but that's expected — the leader is doing the
  // work. The health check distinguishes "not leader" from "stalled" via the
  // `leader` field.
  let status = 'ok';
  if (!redisConnected || !priceRefreshHealth.healthy || !webhookWorkerHealth.healthy || database.status === 'error' || !wsHealth.healthy) {
    const jobsDegraded =
      (!priceRefreshHealth.healthy && !priceRefreshHealth.stalled) ||
      (!webhookWorkerHealth.healthy && !webhookWorkerHealth.stalled);
    status = (!redisConnected || priceRefreshHealth.stalled || webhookWorkerHealth.stalled || database.status === 'error' || !wsHealth.healthy)
      ? 'unhealthy'
      : jobsDegraded ? 'degraded' : 'unhealthy';
  }

  res.json({
    status,
    timestamp: new Date().toISOString(),
    redis_connected: redisConnected,
    redis_unavailable: !redisConnected,
    circuits: priceOracle.getCircuitStates(),
    redis: {
      connected: redisConnected,
    },
    websocket: {
      healthy: wsHealth.healthy,
      connections: wsHealth.connections,
      error: wsHealth.error,
    },
    jobs: {
      price_refresh: {
        healthy: priceRefreshHealth.healthy,
        last_success_at: priceRefreshHealth.lastSuccessAt
          ? new Date(priceRefreshHealth.lastSuccessAt).toISOString()
          : null,
        last_error: priceRefreshHealth.lastError,
        stalled: priceRefreshHealth.stalled,
        leader: priceRefreshHealth.leader,
        leader_instance_id: priceRefreshHealth.leaderInstanceId,
        leader_since: priceRefreshHealth.leaderSince,
      },
      webhook_retry_worker: {
        healthy: webhookWorkerHealth.healthy,
        last_success_at: webhookWorkerHealth.lastSuccessAt
          ? new Date(webhookWorkerHealth.lastSuccessAt).toISOString()
          : null,
        last_error: webhookWorkerHealth.lastError,
        stalled: webhookWorkerHealth.stalled,
        leader: webhookWorkerHealth.leader,
        leader_instance_id: webhookWorkerHealth.leaderInstanceId,
        leader_since: webhookWorkerHealth.leaderSince,
      },
      airdrop_expiry: {
        healthy: airdropExpiryHealth.healthy,
        last_success_at: airdropExpiryHealth.lastSuccessAt
          ? new Date(airdropExpiryHealth.lastSuccessAt).toISOString()
          : null,
        last_error: airdropExpiryHealth.lastError,
        stalled: airdropExpiryHealth.stalled,
        leader: airdropExpiryHealth.leader,
        leader_instance_id: airdropExpiryHealth.leaderInstanceId,
        leader_since: airdropExpiryHealth.leaderSince,
      },
    },
    database,
    price_source_circuits: priceOracle.getSourceCircuitStates(),
    leader_election: {
      instance_id: config.leaderElection.instanceId,
      lease_ttl_ms: config.leaderElection.leaseTtlMs,
      renew_interval_ms: config.leaderElection.renewIntervalMs,
    },
  });
});

const globalApiLimit = buildRateLimit({
  windowSeconds: Math.floor(config.rateLimit.windowMs / 1000),
  max: config.rateLimit.max,
  keyPrefix: 'api',
});

app.use('/api/v1', globalApiLimit);
app.use('/api/v1', pricesRouter);
app.use('/api/v1', keysRouter);
app.use('/api/v1/alerts', requireApiKey());
app.use('/api/v1', alertsRouter);
app.use('/api/v1', indexerRouter);
app.use('/api/v1', webhooksRouter);
app.use('/api/v1', airdropsRouter);
app.use('/api-docs', globalApiLimit);
app.use('/api-docs', apiDocsRouter);
app.use(metricsRouter);

app.use(notFoundHandler);
app.use(errorHandler);

function shutdown(signal) {
  return async () => {
    logger.info(`${signal} received, shutting down`);

    // Stop leader-aware jobs (releases leases gracefully)
    await wrappedPriceRefreshJob.stop();
    await wrappedWebhookRetryWorker.stop();
    await wrappedAirdropExpiryJob.stop();

    // Stop non-leader-elected services
    indexerPoller.stop();
    require('./ws/PriceSubscriptionManager').stopHeartbeat();

    if (server) server.close();
    await cache.disconnect();
    process.exit(0);
  };
}

async function startServer() {
  await warmCache(config.watchedAssets);

  server = app.listen(config.port, () => {
    logger.info(`SmartDrop backend running on port ${config.port}`);
    priceWebSocket.attach(server);

    // Start leader-aware background jobs.
    // Each wrapped job starts a leader-election renewal loop. The underlying
    // job (cron / setInterval) is only activated when this instance holds
    // the leader lease. Non-leader instances remain ready to take over.
    wrappedPriceRefreshJob.start();
    wrappedWebhookRetryWorker.start();
    wrappedAirdropExpiryJob.start();

    // Indexer poller is not leader-elected (it uses its own cursor-based
    // persistence in Redis and is safe for multiple replicas to run).
    indexerPoller.start();
  });

  return server;
}

if (require.main === module) {
  startServer().catch((err) => {
    logger.error('Startup failed', { error: err.message });
    process.exit(1);
  });

  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));

  // Last-resort safety net for errors that escape all per-job try/catch blocks.
  // These handlers do not replace the existing error handling in priceRefresh.js,
  // webhookRetryWorker.js, etc. — they are a fallback for truly unexpected throws.

  // unhandledRejection: Node >=20 exits by default; we match that behavior but
  // run the cleanup sequence first so Redis connections and in-flight jobs are
  // shut down cleanly rather than abandoned abruptly.
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection — initiating graceful shutdown', {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    shutdown('unhandledRejection')();
  });

  // uncaughtException: the process heap is in an undefined state after this event.
  // Log and shut down; never swallow and continue running in a potentially corrupt state.
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception — initiating graceful shutdown', {
      error: err.message,
      stack: err.stack,
    });
    shutdown('uncaughtException')();
  });
}

module.exports = {
  app,
  server: server || {
    close(callback) {
      if (callback) callback();
    },
  },
  startServer,
  // Exposed for testing
  wrappedPriceRefreshJob,
  wrappedWebhookRetryWorker,
  wrappedAirdropExpiryJob,
};
