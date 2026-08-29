'use strict';

const express = require('express');
const cache = require('../services/cache');
const eventStore = require('../indexer/eventStore');
const indexerPoller = require('../indexer/runtime');
const webhookRepo = require('../repositories/webhookRepository');
const deliveryRepo = require('../repositories/deliveryRepository');

const router = express.Router();

// Simple in-memory counters (reset on process restart)
const counters = {
  http_requests_total: 0,
  http_errors_total: 0,
  webhook_deliveries_total: 0,
  webhook_delivery_errors_total: 0,
  price_cache_hits: 0,
  price_cache_misses: 0,
};

// Track request metrics via a middleware
function requestMetricsMiddleware(req, res, next) {
  counters.http_requests_total++;
  const originalEnd = res.end;
  res.end = function (...args) {
    if (res.statusCode >= 400) {
      counters.http_errors_total++;
    }
    originalEnd.apply(this, args);
  };
  next();
}

function incCounter(name) {
  counters[name] = (counters[name] || 0) + 1;
}

async function metricsHandler(_req, res) {
  try {
    const lines = [];

    // HTTP metrics
    lines.push('# HELP http_requests_total Total HTTP requests');
    lines.push('# TYPE http_requests_total counter');
    lines.push(`http_requests_total ${counters.http_requests_total}`);

    lines.push('# HELP http_errors_total Total HTTP errors (4xx+5xx)');
    lines.push('# TYPE http_errors_total counter');
    lines.push(`http_errors_total ${counters.http_errors_total}`);

    // Webhook metrics
    lines.push('# HELP webhook_deliveries_total Total webhook deliveries attempted');
    lines.push('# TYPE webhook_deliveries_total counter');
    lines.push(`webhook_deliveries_total ${counters.webhook_deliveries_total}`);

    lines.push('# HELP webhook_delivery_errors_total Total failed webhook deliveries');
    lines.push('# TYPE webhook_delivery_errors_total counter');
    lines.push(`webhook_delivery_errors_total ${counters.webhook_delivery_errors_total}`);

    // Price cache metrics
    lines.push('# HELP price_cache_hits_total Price cache hits');
    lines.push('# TYPE price_cache_hits_total counter');
    lines.push(`price_cache_hits_total ${counters.price_cache_hits}`);

    lines.push('# HELP price_cache_misses_total Price cache misses');
    lines.push('# TYPE price_cache_misses_total counter');
    lines.push(`price_cache_misses_total ${counters.price_cache_misses}`);

    // Indexer status
    const indexerStatus = indexerPoller.getStatus();
    lines.push('# HELP indexer_running Whether the indexer poller is running');
    lines.push('# TYPE indexer_running gauge');
    lines.push(`indexer_running ${indexerStatus.running ? 1 : 0}`);

    lines.push('# HELP indexer_latest_ledger Latest ledger processed by indexer');
    lines.push('# TYPE indexer_latest_ledger gauge');
    lines.push(`indexer_latest_ledger ${indexerStatus.latest_ledger || 0}`);

    // Indexer event count
    const stats = await eventStore.getStats();
    lines.push('# HELP indexer_events_total Total indexed events');
    lines.push('# TYPE indexer_events_total gauge');
    lines.push(`indexer_events_total ${stats.events_count}`);

    // Active webhooks
    const allWebhooks = await webhookRepo.listAll();
    const activeWebhooks = allWebhooks.filter((w) => w.active);
    lines.push('# HELP webhooks_active Number of active webhooks');
    lines.push('# TYPE webhooks_active gauge');
    lines.push(`webhooks_active ${activeWebhooks.length}`);

    // Redis connectivity
    const redisConnected = cache.isConnected();
    lines.push('# HELP redis_connected Whether Redis is connected');
    lines.push('# TYPE redis_connected gauge');
    lines.push(`redis_connected ${redisConnected ? 1 : 0}`);

    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(lines.join('\n') + '\n');
  } catch (err) {
    res.status(500).send('# Error generating metrics\n');
  }
}

router.get('/metrics', metricsHandler);

module.exports = { router, requestMetricsMiddleware, incCounter, counters };
