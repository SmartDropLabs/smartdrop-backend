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
// Most cache keys this process tracks for eviction (#700). Past this bound the
// least recently used entry is deleted from Redis. Override with
// DB_CACHE_MAX_ENTRIES.
const MAX_TRACKED_ENTRIES = parseInt(process.env.DB_CACHE_MAX_ENTRIES, 10) || 10000;
// Insertion order is recency order: a key is re-inserted on every use.
const trackedKeys = new Map();

/**
 * Mark a cache key as most recently used, then evict the oldest tracked keys
 * while over the limit. A failed eviction is logged and does not fail the query.
 * @param {string} key
 */
async function trackKey(key) {
  trackedKeys.delete(key);
  trackedKeys.set(key, true);
  while (trackedKeys.size > MAX_TRACKED_ENTRIES) {
    const oldest = trackedKeys.keys().next().value;
    trackedKeys.delete(oldest);
    try {
      await cache.del(oldest);
    } catch (err) {
      logger.warn('dbCache: failed to evict cache entry', { error: err.message });
    }
  }
}

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

  const result = await fetchWithLock(
    cacheKey,
    () => executor(query, params),
    {
      ttlSeconds,
      skipCache,
      backgroundRefresh,
      ...restOptions,
    }
  );
  await trackKey(cacheKey);
  return result;
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

/**
 * Invalidate cached record by ID and optional entity name.
 * Default key pattern: `record:${id}`.
 */
async function invalidateRecord(id, entity = 'record') {
  if (!id) return;
  const key = entity ? `${entity}:${id}` : `record:${id}`;
  await cache.del(key);
  if (entity !== 'record') {
    await cache.del(`record:${id}`);
  }
}

/**
 * Execute write operation and invalidate cache for the affected record (#644).
 *
 * @param {string|number} id - Record ID
 * @param {Object|Function} dataOrFn - Update payload or updater function
 * @param {Object} [db] - Database client with update method (optional)
 * @returns {Promise<*>} Result of the update
 */
async function updateRecord(id, dataOrFn, db) {
  let result;
  if (db && typeof db.update === 'function') {
    result = await db.update(id, dataOrFn);
  } else if (typeof dataOrFn === 'function') {
    result = await dataOrFn(id);
  } else if (db && typeof db.query === 'function') {
    result = await db.query(dataOrFn, [id]);
  }
  await invalidateRecord(id);
  return result;
}

/**
 * Higher-order helper to wrap any write operation and invalidate cache.
 */
async function executeWriteAndInvalidate(id, writeOperation, entity = 'record') {
  const result = await writeOperation();
  await invalidateRecord(id, entity);
  return result;
}

module.exports = {
  cachedQuery,
  getTrackedKeyCount: () => trackedKeys.size,
  invalidateQueryCache,
  generateCacheKey,
  invalidateRecord,
  updateRecord,
  executeWriteAndInvalidate,
};
