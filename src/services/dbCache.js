'use strict';

const cache = require('./cache');
const logger = require('../logger');

/**
 * #452 — Database query caching layer.
 *
 * Provides a simple wrapper around database queries with Redis caching
 * to reduce redundant queries. Cache keys are generated from the query
 * and parameters, with configurable TTL.
 *
 * Usage:
 *   const result = await cachedQuery('SELECT * FROM users WHERE id = $1', [userId], { ttlSeconds: 60 });
 */

const DEFAULT_TTL_SECONDS = 60;
const MAX_CACHE_KEY_LENGTH = 256;

/**
 * Generate a cache key from query and parameters.
 * Uses a deterministic hash to keep keys short.
 */
function generateCacheKey(query, params) {
  const crypto = require('crypto');
  const content = JSON.stringify({ query, params });
  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 32);
  return `dbq:${hash}`;
}

/**
 * Execute a query with caching support.
 * Returns cached result if available, otherwise executes the query
 * and caches the result.
 *
 * @param {string} query - SQL query string
 * @param {Array} params - Query parameters
 * @param {Object} options - Cache options
 * @param {number} options.ttlSeconds - Cache TTL in seconds (default: 60)
 * @param {boolean} options.skipCache - Skip cache and force fresh query
 * @param {Function} options.executor - Query executor function (required)
 * @returns {Promise<*>} Query result
 */
const { fetchWithLock } = require('../cache');

/**
 * Execute a query with caching support and cache stampede protection (#518).
 * Returns cached result if available, otherwise executes the query under lock
 * to prevent multiple concurrent requests from hitting the database simultaneously.
 *
 * @param {string} query - SQL query string
 * @param {Array} params - Query parameters
 * @param {Object} options - Cache options
 * @param {number} options.ttlSeconds - Cache TTL in seconds (default: 60)
 * @param {boolean} options.skipCache - Skip cache and force fresh query
 * @param {boolean} options.backgroundRefresh - Refresh cache in background when expired
 * @param {Function} options.executor - Query executor function (required)
 * @returns {Promise<*>} Query result
 */
async function cachedQuery(query, params = [], options = {}) {
  const {
    ttlSeconds = DEFAULT_TTL_SECONDS,
    skipCache = false,
    backgroundRefresh = false,
    executor,
    ...restOptions
  } = options;

  if (!executor) {
    throw new Error('cachedQuery: executor function is required');
  }

  const cacheKey = generateCacheKey(query, params);

  return fetchWithLock(
    cacheKey,
    () => executor(query, params),
    {
      ttlSeconds,
      skipCache,
      backgroundRefresh,
      ...restOptions,
    }
  );
}

/**
 * Invalidate cached query results matching a pattern.
 * Note: This is a best-effort invalidation — Redis doesn't support
 * pattern-based key deletion efficiently without SCAN.
 */
async function invalidateQueryCache(queryPattern) {
  logger.info('Database query cache invalidation requested', { pattern: queryPattern });
  // In production, you would use SCAN + DEL with a pattern
  // For now, this is a placeholder that logs the request
}

module.exports = {
  cachedQuery,
  invalidateQueryCache,
  generateCacheKey,
};
