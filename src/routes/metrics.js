'use strict';

/**
 * Metrics Router (#467).
 * Connects Express router with the Prometheus text exporter in src/metrics/.
 */

const express = require('express');
const {
  metricsHandler,
  requestMetricsMiddleware,
  incCounter,
  registry,
  httpRequestsTotal,
} = require('../metrics');

const router = express.Router();

// Forward compatibility + backward compatibility proxy for legacy counters object
const counters = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === 'http_requests_total') {
        let sum = 0;
        for (const entry of httpRequestsTotal.values.values()) {
          sum += entry.value;
        }
        return sum;
      }
      const metric = registry.getMetric(prop);
      if (metric && typeof metric.get === 'function') {
        return metric.get();
      }
      return 0;
    },
    set(_target, prop, val) {
      const metric = registry.getMetric(prop);
      if (metric && typeof metric.inc === 'function') {
        metric.inc({}, val);
      }
      return true;
    },
  }
);

router.get('/metrics', metricsHandler);

module.exports = {
  router,
  metricsHandler,
  requestMetricsMiddleware,
  incCounter,
  counters,
  registry,
};
