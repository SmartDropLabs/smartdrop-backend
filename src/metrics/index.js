'use strict';

/**
 * SmartDrop Prometheus Metrics Exporter (Issue #467).
 *
 * Implements:
 * - Prometheus text exposition format (version 0.0.4)
 * - HTTP metrics (requests_total, duration histogram, in_flight gauge)
 * - Cardinality control: labeled by route template or 'unmatched', never raw URLs
 * - Process metrics (CPU, memory, uptime, event loop lag)
 * - Subsystem telemetry (cache hits/misses, Redis, circuit breakers, webhooks, indexer)
 * - Endpoint protection (bearer token / basic credentials via constant-time comparison)
 * - Avoids recursion: /metrics itself is excluded from HTTP traffic counts
 */

const crypto = require('crypto');
const { Registry } = require('./registry');
const cache = require('../services/cache');
const AppError = require('../errors/AppError');
const logger = require('../logger');

const registry = new Registry();

// ── HTTP Metrics ─────────────────────────────────────────────────────────────
const httpRequestsTotal = registry.counter(
  'http_requests_total',
  'Total HTTP requests processed'
);

const httpRequestDuration = registry.histogram(
  'http_request_duration_seconds',
  'HTTP request latency in seconds',
  { buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] }
);

const httpRequestsInFlight = registry.gauge(
  'http_requests_in_flight',
  'Current number of HTTP requests being processed'
);

// ── Process Metrics ──────────────────────────────────────────────────────────
const processCpuUser = registry.counter(
  'process_cpu_user_seconds_total',
  'Total user CPU time spent in seconds'
);
const processCpuSystem = registry.counter(
  'process_cpu_system_seconds_total',
  'Total system CPU time spent in seconds'
);
const processResidentMemory = registry.gauge(
  'process_resident_memory_bytes',
  'Resident set size (RSS) memory in bytes'
);
const processHeapUsed = registry.gauge(
  'process_heap_bytes',
  'Process heap memory used in bytes'
);
const processHeapTotal = registry.gauge(
  'process_heap_total_bytes',
  'Total allocated process heap in bytes'
);
const processStartTime = registry.gauge(
  'process_start_time_seconds',
  'Start time of the process since unix epoch in seconds'
);
const processUptime = registry.gauge(
  'process_uptime_seconds',
  'Number of seconds the process has been running'
);
const eventLoopLagGauge = registry.gauge(
  'nodejs_eventloop_lag_seconds',
  'Event loop lag in seconds'
);

// Set start time once
processStartTime.set({}, Math.floor(Date.now() / 1000 - process.uptime()));

// ── Subsystem Metrics ────────────────────────────────────────────────────────
const priceCacheHits = registry.counter(
  'price_cache_hits_total',
  'Total price cache hits'
);
const priceCacheMisses = registry.counter(
  'price_cache_misses_total',
  'Total price cache misses'
);
const webhookDeliveriesTotal = registry.counter(
  'webhook_deliveries_total',
  'Total webhook deliveries attempted'
);
const webhookDeliveryErrors = registry.counter(
  'webhook_delivery_errors_total',
  'Total failed webhook deliveries'
);
const redisConnectedGauge = registry.gauge(
  'redis_connected',
  'Whether Redis client is connected and ready (1 = connected, 0 = disconnected)'
);
const redisQueueDepthGauge = registry.gauge(
  'redis_command_queue_depth',
  'Number of pending commands in Redis client command queue'
);
const circuitBreakerStateGauge = registry.gauge(
  'circuit_breaker_state',
  'State of circuit breakers (0 = CLOSED, 1 = HALF_OPEN, 2 = OPEN)'
);

// Event loop lag measurement
let lastLagCheck = Date.now();
let eventLoopLagSeconds = 0;
const lagInterval = setInterval(() => {
  const now = Date.now();
  const delta = now - lastLagCheck - 1000;
  eventLoopLagSeconds = Math.max(0, delta) / 1000;
  lastLagCheck = now;
}, 1000);
if (typeof lagInterval.unref === 'function') {
  lagInterval.unref();
}

/**
 * Safely resolves the matched route pattern without exposing high cardinality
 * path parameters or leaking sensitive data.
 */
function resolveRoutePattern(req, res) {
  // If request route is /metrics, return /metrics
  if (req.path === '/metrics') return '/metrics';

  // Express attaches route information when a router matches
  if (req.route && req.route.path) {
    const base = req.baseUrl || '';
    let routePath = req.route.path;
    if (routePath instanceof RegExp) {
      routePath = routePath.toString();
    }
    return `${base}${routePath}`;
  }

  // If status is 404 or unmatched
  if (res.statusCode === 404) {
    return 'unmatched';
  }

  // Handle standard known versioned paths
  const cleanPath = (req.path || '').split('?')[0];
  if (cleanPath.startsWith('/health')) return '/health';
  if (cleanPath.startsWith('/api-docs')) return '/api-docs';
  if (cleanPath === '/csrf-token') return '/csrf-token';

  return 'unmatched';
}

/**
 * Express middleware to observe HTTP traffic.
 * Placed early to count requests rejected by earlier middleware.
 */
function requestMetricsMiddleware(req, res, next) {
  // Do NOT count /metrics itself to avoid recursive distortion of operational metrics
  if (req.path === '/metrics') {
    return next();
  }

  httpRequestsInFlight.inc();
  const startTime = process.hrtime.bigint();

  res.on('finish', () => {
    httpRequestsInFlight.dec();
    const durationSec = Number(process.hrtime.bigint() - startTime) / 1e9;
    const method = req.method ? req.method.toUpperCase() : 'UNKNOWN';
    const status = String(res.statusCode || 200);
    const route = resolveRoutePattern(req, res);

    const labels = { method, route, status };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, durationSec);
  });

  next();
}

/**
 * Updates process telemetry right before serializing output.
 */
function updateProcessMetrics() {
  const cpu = process.cpuUsage();
  processCpuUser.set({}, cpu.user / 1e6);
  processCpuSystem.set({}, cpu.system / 1e6);

  const mem = process.memoryUsage();
  processResidentMemory.set({}, mem.rss);
  processHeapUsed.set({}, mem.heapUsed);
  processHeapTotal.set({}, mem.heapTotal);

  processUptime.set({}, Math.floor(process.uptime()));
  eventLoopLagGauge.set({}, eventLoopLagSeconds);
}

/**
 * Updates subsystem telemetry right before serializing output.
 */
async function updateSubsystemMetrics() {
  // Redis state
  try {
    const connected = cache.isConnected && cache.isConnected();
    redisConnectedGauge.set({}, connected ? 1 : 0);
    const queueDepth = cache.getCommandQueueLength ? cache.getCommandQueueLength() : 0;
    redisQueueDepthGauge.set({}, queueDepth);
  } catch (err) {
    redisConnectedGauge.set({}, 0);
  }

  // Circuit breaker state
  try {
    const { getAllBreakerStates } = require('../utils/circuitBreaker');
    const breakerStates = getAllBreakerStates();
    for (const [name, info] of Object.entries(breakerStates)) {
      const stateVal = info.state === 'OPEN' ? 2 : info.state === 'HALF_OPEN' ? 1 : 0;
      circuitBreakerStateGauge.set({ name, state: info.state }, stateVal);
    }
  } catch {
    // If circuitBreaker registry is absent or empty, omit
  }
}

/**
 * Check metrics endpoint authorization.
 */
function checkMetricsAuth(req) {
  const isEnabled = process.env.METRICS_ENABLED !== 'false';
  if (!isEnabled) {
    return { authorized: false, reason: 'DISABLED' };
  }

  const expectedToken = process.env.METRICS_AUTH_TOKEN;
  const isDev = (process.env.NODE_ENV || 'development') === 'development';

  // If no auth token is configured and we are in development, allow access
  if (!expectedToken) {
    if (isDev) return { authorized: true };
    // Outside development, protected by default if credentials are not configured
    return { authorized: false, reason: 'UNAUTHORIZED' };
  }

  // Check Bearer Token or Basic Auth
  const authHeader = req.get('authorization') || '';
  let providedToken = null;

  if (authHeader.startsWith('Bearer ')) {
    providedToken = authHeader.slice(7).trim();
  } else if (authHeader.startsWith('Basic ')) {
    try {
      const creds = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
      const parts = creds.split(':');
      providedToken = parts[1] || parts[0];
    } catch {
      providedToken = null;
    }
  }

  if (!providedToken) {
    return { authorized: false, reason: 'UNAUTHORIZED' };
  }

  const providedBuf = Buffer.from(providedToken, 'utf8');
  const expectedBuf = Buffer.from(expectedToken, 'utf8');

  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return { authorized: false, reason: 'UNAUTHORIZED' };
  }

  // Check IP allowlist if configured
  const allowedIps = process.env.METRICS_ALLOWED_IPS
    ? process.env.METRICS_ALLOWED_IPS.split(',').map((ip) => ip.trim()).filter(Boolean)
    : [];

  if (allowedIps.length > 0) {
    const clientIp = req.ip || req.socket?.remoteAddress || '';
    const isIpAllowed = allowedIps.some((allowed) => clientIp.includes(allowed));
    if (!isIpAllowed) {
      return { authorized: false, reason: 'FORBIDDEN' };
    }
  }

  return { authorized: true };
}

/**
 * Express handler for GET /metrics in Prometheus text exposition format.
 */
async function metricsHandler(req, res) {
  const authCheck = checkMetricsAuth(req);
  if (!authCheck.authorized) {
    if (authCheck.reason === 'DISABLED') {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Metrics endpoint is disabled' },
      });
    }
    if (authCheck.reason === 'FORBIDDEN') {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Access forbidden from this IP' },
      });
    }
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Authentication required for metrics' },
    });
  }

  try {
    updateProcessMetrics();
    await updateSubsystemMetrics();

    const output = registry.serialize();
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return res.status(200).send(output);
  } catch (err) {
    logger.error('Failed to generate metrics', { error: err.message });
    return res.status(500).send('# Error generating metrics\n');
  }
}

function incCounter(name, labels = {}) {
  const m = registry.getMetric(name);
  if (m && typeof m.inc === 'function') {
    m.inc(labels);
  }
}

module.exports = {
  registry,
  metricsHandler,
  requestMetricsMiddleware,
  resolveRoutePattern,
  checkMetricsAuth,
  incCounter,
  httpRequestsTotal,
  httpRequestDuration,
  httpRequestsInFlight,
  priceCacheHits,
  priceCacheMisses,
  webhookDeliveriesTotal,
  webhookDeliveryErrors,
};
