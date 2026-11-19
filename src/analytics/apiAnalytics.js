'use strict';

/**
 * API usage analytics (#537).
 *
 * Tracks per-route request counts, status-code distribution, and response
 * times entirely in-process. Designed to be read by the /metrics endpoint or
 * an external scraper. No external dependency required.
 *
 * Usage:
 *   const { analyticsMiddleware, getSnapshot, resetCounters } = require('./apiAnalytics');
 *   app.use(analyticsMiddleware());
 *   // GET /metrics → getSnapshot()
 */

/** @type {Map<string, RouteStats>} key = "METHOD /path" */
const stats = new Map();

/**
 * @typedef {Object} RouteStats
 * @property {number} requests   Total request count.
 * @property {number} totalMs    Cumulative response time (ms).
 * @property {Map<number, number>} statusCodes  Count per HTTP status code.
 */

function routeKey(method, path) {
  return `${method.toUpperCase()} ${path}`;
}

function getOrCreate(key) {
  if (!stats.has(key)) {
    stats.set(key, { requests: 0, totalMs: 0, statusCodes: new Map() });
  }
  return stats.get(key);
}

/**
 * Express middleware that records request counts, status codes, and latency
 * for every route. Normalizes dynamic path segments (e.g. /users/123 →
 * /users/:id) using Express's req.route when available, falling back to the
 * raw URL path so unmatched routes are still tracked.
 */
function analyticsMiddleware() {
  return function trackApiUsage(req, res, next) {
    const startMs = Date.now();

    res.on('finish', () => {
      const elapsedMs = Date.now() - startMs;
      // Prefer the matched route pattern over the raw URL to avoid
      // combinatorial explosion of keys from path parameters.
      const routePath = (req.route && req.route.path) || req.path || req.url || '/';
      const key = routeKey(req.method, routePath);
      const entry = getOrCreate(key);

      entry.requests += 1;
      entry.totalMs += elapsedMs;
      const code = res.statusCode;
      entry.statusCodes.set(code, (entry.statusCodes.get(code) || 0) + 1);
    });

    next();
  };
}

/**
 * Returns a plain-object snapshot of all collected analytics data.
 * Safe to serialise with JSON.stringify.
 *
 * @returns {{ routes: Array<RouteSnapshot> }}
 */
function getSnapshot() {
  const routes = [];
  for (const [key, entry] of stats.entries()) {
    const [method, ...pathParts] = key.split(' ');
    const path = pathParts.join(' ');
    const avgMs = entry.requests > 0 ? entry.totalMs / entry.requests : 0;
    const statusCodes = {};
    for (const [code, count] of entry.statusCodes.entries()) {
      statusCodes[code] = count;
    }
    routes.push({
      method,
      path,
      requests: entry.requests,
      avgResponseMs: Math.round(avgMs * 100) / 100,
      statusCodes,
    });
  }
  routes.sort((a, b) => b.requests - a.requests);
  return { routes };
}

/**
 * Reset all counters. Primarily useful in tests.
 */
function resetCounters() {
  stats.clear();
}

module.exports = { analyticsMiddleware, getSnapshot, resetCounters };
