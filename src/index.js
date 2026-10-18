"use strict";

// Issue #494 — establish a UTC default for the process before anything
// formats a date. This is a defensive default only: every timestamp the app
// emits is built from toISOString()/UTC math (src/utils/dates.js), so
// behaviour must not depend on this line. The primary fix is the TZ=UTC
// environment in Dockerfile/docker-compose; see README.md#time-handling.
const { assertUtcTimeZone } = require("./utils/dates");
const timeZoneState = assertUtcTimeZone();

const express = require("express");
const config = require("./config");
const compression = require("compression");
const helmet = require("helmet");
const config = require("./config");
const { version: appVersion } = require("../package.json");
const logger = require("./logger");
const cache = require("./services/cache");
const priceOracle = require("./services/priceOracle");
const priceRefreshJob = require("./jobs/priceRefresh");
const webhookRetryWorker = require("./jobs/webhookRetryWorker");
const airdropExpiryJob = require("./jobs/airdropExpiry");
const jobQueue = require("./services/jobQueue");
const { createLeaderElection } = require("./services/leaderElection");
const { makeLeaderAwareJob } = require("./jobs/leaderAwareJob");
const { warmCacheInBackground, getWarmStatus } = require("./startup/cacheWarm");
const buildCorsMiddleware = require("./middleware/cors");
const {
  buildRateLimit,
  buildApiKeyRateLimit,
} = require("./middleware/rateLimit");
const { requestIdMiddleware } = require("./middleware/requestId");
const { headerSecurityMiddleware } = require("./middleware/headerSecurity");
const {
  API_CSP_DIRECTIVES,
  docsCspMiddleware,
} = require("./middleware/csp");
const requestLoggerMiddleware = require("./middleware/requestLogger");
const { createStaticAssetsMiddleware } = require("./middleware/staticAssets");
const {
  requireApiKey,
  attachApiKey,
  auditApiKeyUsage,
} = require("./middleware/auth");
const { errorHandler, notFoundHandler } = require("./middleware/errorHandler");
const { jsonReplacer } = require("./utils/serialization");
const { checkDatabase } = require("./services/dbHealth");
const pricesRouter = require("./routes/prices");
const alertsRouter = require("./routes/alerts");
const indexerRouter = require("./routes/indexer");
const indexerPoller = require("./indexer/runtime");
const keysRouter = require("./routes/keys");
const webhooksRouter = require("./routes/webhooks");
const airdropsRouter = require("./routes/airdrops");
const apiDocsRouter = require("./routes/apiDocs");
const {
  router: metricsRouter,
  requestMetricsMiddleware,
} = require("./routes/metrics");
const healthRouter = require("./health");

const priceWebSocket = require("./ws/priceWebSocket");
const subscriptionManager = require("./ws/PriceSubscriptionManager");
const webhookDispatcher = require("./services/webhookDispatcher");
const { getAllBreakerStates } = require("./utils/circuitBreaker");

// Wrap background jobs with leader-election coordination so that only one
// replica across the deployment runs each job at any given time.
// See README.md#leader-election for design, failover timing, and configuration.
const leaderElectionPriceRefresh = createLeaderElection("price_refresh");
const leaderElectionWebhookRetry = createLeaderElection("webhook_retry");
const leaderElectionAirdropExpiry = createLeaderElection("airdrop_expiry");

const wrappedPriceRefreshJob = makeLeaderAwareJob({
  job: priceRefreshJob,
  jobName: "price_refresh",
  leaderElection: leaderElectionPriceRefresh,
  logger,
});

const wrappedWebhookRetryWorker = makeLeaderAwareJob({
  job: webhookRetryWorker,
  jobName: "webhook_retry",
  leaderElection: leaderElectionWebhookRetry,
  logger,
});

const wrappedAirdropExpiryJob = makeLeaderAwareJob({
  job: airdropExpiryJob,
  jobName: "airdrop_expiry",
  leaderElection: leaderElectionAirdropExpiry,
  logger,
});

const app = express();

// Issue #496 — secure cookies require trust proxy to reflect original
// protocol when behind a load balancer/reverse proxy. Default is `false`
// (explicit, to avoid rate-limit/IP spoofing if ever used). The config
// exposes TRUST_PROXY; enable only if the deployment is proxy-fronted.
if (typeof config.trustProxy === 'boolean') {
  app.set('trust proxy', config.trustProxy);
}
let server = {
  close(callback) {
    if (callback) callback();
  },
};

app.use(headerSecurityMiddleware);
app.use(requestIdMiddleware);
app.use(requestLoggerMiddleware);
app.use(requestMetricsMiddleware);
app.use(compression());
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: API_CSP_DIRECTIVES,
    },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    xContentTypeOptions: true,
    xDownloadOptions: true,
  })
);
app.use(buildCorsMiddleware(config.corsAllowedOrigins));
// Apply a global body size limit to protect all routes from oversized payloads.
// Individual routes with stricter limits (e.g. airdrops) override this via
// their own express.json({ limit }) middleware (#287).
const DEFAULT_BODY_LIMIT = "1mb";
app.use(express.json({ limit: DEFAULT_BODY_LIMIT }));

const EMPTY_QUEUE_STATS = {
  pendingRetries: null,
  lastBatchSize: null,
  avgDeliveryLatencyMs: null,
  totalRetriesProcessed: null,
};

async function readWebhookRetryQueueStats() {
  if (typeof webhookRetryWorker.getQueueStats !== "function")
    return EMPTY_QUEUE_STATS;
  try {
    return await webhookRetryWorker.getQueueStats();
  } catch (err) {
    logger.warn("Could not read webhook retry queue stats", {
      error: err.message,
    });
    return EMPTY_QUEUE_STATS;
  }
}

// #455 — Mount healthRouter for unauthenticated, rate-limit-exempt
// lightweight liveness (/health/live) and dependency readiness (/health/ready) checks.
app.use("/health", healthRouter);

const healthRateLimit = buildRateLimit({
  windowSeconds: Math.floor(config.rateLimit.windowMs / 1000),
  max: config.rateLimit.max,
  keyPrefix: "health",
});

app.get("/health", healthRateLimit, async (req, res) => {
  const redisConnected = cache.isConnected();
  const redisQueueDepth = cache.getCommandQueueLength();
  const redisConcurrency = cache.getConcurrencyStats();
  const priceRefreshHealth = wrappedPriceRefreshJob.getHealth();
  const webhookWorkerHealth = wrappedWebhookRetryWorker.getHealth();
  const airdropExpiryHealth = wrappedAirdropExpiryJob.getHealth();
  const database = await checkDatabase();
  const wsHealth = priceWebSocket.getHealth();
  // Queue depth for the retry worker (issue #235) — "the worker is alive"
  // says nothing about whether retries are piling up behind it. Health must
  // still answer if this telemetry read fails, so a failure degrades to
  // nulls rather than failing the whole endpoint.
  const webhookRetryQueue = await readWebhookRetryQueueStats();

  // Compute overall status:
  //   unhealthy – Redis is down, or a job is stalled past its grace period
  //   degraded  – a job has not yet run but is still within its startup grace period
  //   ok        – all dependencies healthy
  //
  // Note: a non-leader instance reports its jobs as not healthy (since they
  // aren't running locally), but that's expected — the leader is doing the
  // work. The health check distinguishes "not leader" from "stalled" via the
  // `leader` field.
  let status = "ok";
  if (
    !redisConnected ||
    !priceRefreshHealth.healthy ||
    !webhookWorkerHealth.healthy ||
    !airdropExpiryHealth.healthy ||
    database.status === "error"
  ) {
    const jobsDegraded =
      (!priceRefreshHealth.healthy && !priceRefreshHealth.stalled) ||
      (!webhookWorkerHealth.healthy && !webhookWorkerHealth.stalled) ||
      (!airdropExpiryHealth.healthy && !airdropExpiryHealth.stalled);
    status =
      !redisConnected ||
      priceRefreshHealth.stalled ||
      webhookWorkerHealth.stalled ||
      airdropExpiryHealth.stalled ||
      database.status === "error"
        ? "unhealthy"
        : jobsDegraded
          ? "degraded"
          : "unhealthy";
  }

  res.json({
    status,
    timestamp: new Date().toISOString(),
    redis_connected: redisConnected,
    redis_unavailable: !redisConnected,
    circuits: priceOracle.getCircuitStates(),
    circuit_breakers: getAllBreakerStates(),
    redis: {
      connected: redisConnected,
      command_queue_depth: redisQueueDepth,
      concurrency: redisConcurrency,
    },
    websocket: {
      healthy: wsHealth.healthy,
      connections: wsHealth.connections,
      error: wsHealth.error,
      draining: subscriptionManager.isDraining,
      drain_stats: subscriptionManager.drainStats,
    },
    // Issue #495 — cache warm status is an optimization, not a readiness
    // dependency (warming runs in the background).
    cache_warm: getWarmStatus(),
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
        // null pending_retries means Redis could not be read, which is not
        // the same as an empty queue.
        pending_retries: webhookRetryQueue.pendingRetries,
        last_batch_size: webhookRetryQueue.lastBatchSize,
        avg_delivery_latency_ms: webhookRetryQueue.avgDeliveryLatencyMs,
        total_retries_processed: webhookRetryQueue.totalRetriesProcessed,
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
    webhook_metrics: webhookDispatcher.getMetrics(),
    leader_election: {
      instance_id: config.leaderElection.instanceId,
      lease_ttl_ms: config.leaderElection.leaseTtlMs,
      renew_interval_ms: config.leaderElection.renewIntervalMs,
    },
  });
});

const apiKeyLimit = buildApiKeyRateLimit({ keyPrefix: "apikey" });

const globalApiLimit = buildRateLimit({
  windowSeconds: Math.floor(config.rateLimit.windowMs / 1000),
  max: config.rateLimit.max,
  keyPrefix: "api",
});

// #451 — Global rate limit applied to ALL requests, not just /api/v1.
// This prevents abuse of non-API routes (health, docs, etc.) as well.
const globalRateLimit = buildRateLimit({
  windowSeconds: Math.floor(config.rateLimit.windowMs / 1000),
  max: config.rateLimit.max * 2, // More generous for non-API routes
  keyPrefix: "global",
});

// #450 — Request validation middleware: rejects requests with invalid
// Content-Type for POST/PUT/PATCH, and validates JSON body size limits.
const requestValidationMiddleware = require("./middleware/requestValidation");

app.use(globalRateLimit);
app.use(requestValidationMiddleware);
app.use("/static", createStaticAssetsMiddleware(config.staticAssets));

// ==================== API ROUTING & VERSIONING (#460) ====================
// Build the core v1 API router.
const apiV1Router = express.Router();
apiV1Router.use(attachApiKey());
apiV1Router.use(auditApiKeyUsage());
apiV1Router.use(apiKeyLimit);
apiV1Router.use(globalApiLimit);
apiV1Router.use(pricesRouter);
apiV1Router.use(keysRouter);
apiV1Router.use("/alerts", requireApiKey({ scopes: ["alerts"] }));
apiV1Router.use(alertsRouter);
apiV1Router.use(indexerRouter);
apiV1Router.use("/webhooks", requireApiKey({ scopes: ["webhooks"] }));
apiV1Router.use(webhooksRouter);
apiV1Router.use(airdropsRouter);

// Unknown version rejection: return clear 404 for unsupported versions (e.g. /v99/..., /api/v99/...)
app.use((req, res, next) => {
  const versionMatch = req.path.match(/^\/(?:api\/)?v(\d+)(?:\/|$)/i);
  if (versionMatch && versionMatch[1] !== "1") {
    const requestedVersion = `v${versionMatch[1]}`;
    return next(
      new AppError(
        "NOT_FOUND",
        `API version '${requestedVersion}' is not supported. Supported versions: v1`,
        404,
        { requested_version: requestedVersion, supported_versions: ["v1"] },
      ),
    );
  }
  next();
});

// Primary versioned path: /v1/...
app.use("/v1", apiV1Router);

// Versioned path alias: /api/v1/... (preserves existing API clients)
app.use("/api/v1", apiV1Router);

// Deprecation signal for legacy unversioned paths (Deprecation and Sunset headers + warn log)
function legacyDeprecationMiddleware(req, res, next) {
  res.setHeader("Deprecation", "true");
  res.setHeader("Sunset", "Fri, 01 Jan 2027 00:00:00 GMT");
  logger.warn("Legacy unversioned API path accessed", {
    path: req.originalUrl,
    method: req.method,
    suggestion: "Please migrate to versioned endpoints under /v1 or /api/v1",
  });
  next();
}

// Backward-compatible unversioned API mounts: /api/... and direct resource paths
const legacyApiRouter = express.Router();
legacyApiRouter.use(legacyDeprecationMiddleware);
legacyApiRouter.use(apiV1Router);

app.use("/api", legacyApiRouter);
app.use(
  ["/prices", "/keys", "/alerts", "/airdrops", "/webhooks", "/recipients", "/indexer"],
  legacyDeprecationMiddleware,
  apiV1Router,
);

app.use("/api-docs", globalApiLimit);
app.use("/api-docs", docsCspMiddleware);
app.use("/api-docs", apiDocsRouter);
app.use(metricsRouter);

app.use(notFoundHandler);
app.use(errorHandler);

function shutdown(signal) {
  return async () => {
    const inFlightDeliveries = webhookDispatcher.getInFlightCount();
    const wsConnections = subscriptionManager.connectionCount;
    logger.info(`${signal} received, shutting down`, {
      in_flight_webhook_deliveries: inFlightDeliveries,
      ws_connections: wsConnections,
    });

    // Stop accepting new connections immediately.
    if (server) server.close();

    // Stop leader-aware jobs (releases leases gracefully)
    await wrappedPriceRefreshJob.stop();
    await wrappedWebhookRetryWorker.stop();
    await wrappedAirdropExpiryJob.stop();

    const remainingDeliveries = webhookDispatcher.getInFlightCount();
    if (remainingDeliveries > 0) {
      logger.warn(
        "Shutdown complete with in-flight webhook deliveries still pending",
        {
          remaining: remainingDeliveries,
        },
      );
    }

    // Stop non-leader-elected services
    await indexerPoller.stop();
    jobQueue.stop();

    // Gracefully drain WebSocket connections: broadcast close frame,
    // then force-close any still open after the drain timeout (issue #248).
    await subscriptionManager.drain(5000);

    // Wait for in-flight requests to complete (max 10s) before force-closing.
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 10_000);
      if (server) {
        server.close(() => {
          clearTimeout(timeout);
          resolve();
        });
      } else {
        clearTimeout(timeout);
        resolve();
      }
    });

    await cache.disconnect();
    process.exit(0);
  };
}

/**
 * Redacts credentials from a connection URL so it can be logged (issue #236).
 *
 * Returns a placeholder rather than the raw string if parsing fails, since a
 * malformed URL that we cannot parse is also one whose password we cannot
 * locate and strip.
 */
function sanitizeUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) parsed.password = "****";
    if (parsed.username) parsed.username = "****";
    return parsed.toString();
  } catch {
    return "[unparseable]";
  }
}

/**
 * Logs a one-shot startup summary (issue #236).
 *
 * Previously startup logged only the port, so an operator looking at a
 * running instance could not tell which build it was, which Node it ran on,
 * or what it was configured to watch without shelling in.
 */
function logStartupBanner() {
  logger.info(`SmartDrop backend running on port ${config.port}`, {
    app_version: appVersion,
    node_version: process.version,
    node_env: config.nodeEnv,
    port: config.port,
    redis_url: sanitizeUrl(config.redis.url),
    database_url: sanitizeUrl(process.env.DATABASE_URL),
    watched_assets_count: config.watchedAssets.length,
    watched_assets: config.watchedAssets,
    indexer_enabled: config.indexer.enabled,
    instance_id: config.leaderElection.instanceId,
    log_level: process.env.LOG_LEVEL || config.nodeEnv,
    // Issue #494 — surface the process time zone so an operator can confirm
    // the UTC default is in effect (or that they overrode it deliberately).
    time_zone: process.env.TZ,
  });
}

async function startServer() {
  // Issue #494 — report a deliberately overridden, non-UTC process time zone.
  // The code stays UTC-correct regardless (all instants use ISO-8601 Z), but
  // a non-UTC default is worth a warning: anything that later relies on the
  // environment default rather than the shared helpers will drift.
  if (timeZoneState.isNonUtc) {
    logger.warn(
      "Process time zone is not UTC; dates are still handled in UTC (issue #494)",
      { time_zone: timeZoneState.timeZone },
    );
  }

  // Redis being unreachable at boot must not stop the process from coming up
  // (#342): everything below degrades to "no cached state" and recovers on
  // its own once ioredis reconnects. Say so once, explicitly, so an operator
  // reading the logs can tell a degraded boot from a healthy one.
  const redisConnectedAtBoot = cache.isConnected();
  if (!redisConnectedAtBoot) {
    logger.warn(
      "Redis unavailable at startup; starting in degraded mode (no cached state, rate limits, or leader lease until it reconnects)",
      { redis_connected: false },
    );
  }

  // Restore historical delivery counters before we accept traffic (#343).
  // Best-effort: if Redis is unreachable the server still starts with empty
  // counters rather than failing startup (#342).
  try {
    await webhookDispatcher.hydrateMetrics();
  } catch (err) {
    logger.warn(
      "Could not load persisted webhook delivery metrics; starting with empty counters",
      { error: err.message },
    );
  }

  // Issue #495 — do NOT block listen on cache warming. Warm in the
  // background with bounding (max entries, concurrency, per-entry timeout),
  // Redis lock so only one replica warms at a time, jitter and TTL.
  // The server can accept traffic immediately; /health exposes cache_warm.
  warmCacheInBackground({
    assets: config.watchedAssets,
    timeoutMs: config.cacheWarm.timeoutMs,
    entryTimeoutMs: config.cacheWarm.entryTimeoutMs,
    maxEntries: config.cacheWarm.maxEntries,
    concurrency: config.cacheWarm.concurrency,
    jitterMs: config.cacheWarm.jitterMs,
    lockTtlMs: config.cacheWarm.lockTtlMs,
    enabled: config.cacheWarm.enabled,
  }).catch((err) => {
    logger.warn("Cache warm failed; starting server anyway", {
      error: err.message,
    });
  });

  server = app.listen(config.port, () => {
    logStartupBanner();
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

    // #510 — start async job queue for background task processing
    jobQueue.start();
  });

  return server;
}

if (require.main === module) {
  startServer().catch((err) => {
    logger.error("Startup failed", { error: err.message });
    process.exit(1);
  });

  process.on("SIGTERM", shutdown("SIGTERM"));
  process.on("SIGINT", shutdown("SIGINT"));

  // Last-resort safety net for errors that escape all per-job try/catch blocks.
  // These handlers do not replace the existing error handling in priceRefresh.js,
  // webhookRetryWorker.js, etc. — they are a fallback for truly unexpected throws.

  // unhandledRejection: Node >=20 exits by default; we match that behavior but
  // run the cleanup sequence first so Redis connections and in-flight jobs are
  // shut down cleanly rather than abandoned abruptly.
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection — initiating graceful shutdown", {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    shutdown("unhandledRejection")();
  });

  // uncaughtException: the process heap is in an undefined state after this event.
  // Log and shut down; never swallow and continue running in a potentially corrupt state.
  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception — initiating graceful shutdown", {
      error: err.message,
      stack: err.stack,
    });
    shutdown("uncaughtException")();
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
  logStartupBanner,
  sanitizeUrl,
  wrappedPriceRefreshJob,
  wrappedWebhookRetryWorker,
  wrappedAirdropExpiryJob,
};
