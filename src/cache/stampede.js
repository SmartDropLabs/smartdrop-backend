'use strict';

const crypto = require('crypto');
const cache = require('../services/cache');
const logger = require('../logger');

/**
 * Singleflight: in-process promise coalescing for concurrent calls.
 * Ensures that for any given key, only one promise is actively executing
 * at any given time within this process.
 */
class SingleFlight {
  constructor() {
    this._inFlight = new Map();
  }

  /**
   * Execute fn(key) or share an existing in-flight execution for key.
   *
   * @param {string} key
   * @param {Function} fn
   * @returns {Promise<*>}
   */
  async do(key, fn) {
    if (this._inFlight.has(key)) {
      return this._inFlight.get(key);
    }

    const promise = (async () => {
      try {
        return await fn();
      } finally {
        this._inFlight.delete(key);
      }
    })();

    this._inFlight.set(key, promise);
    return promise;
  }

  /**
   * Check if a key is currently in-flight.
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this._inFlight.has(key);
  }

  /**
   * Number of currently in-flight keys.
   */
  get size() {
    return this._inFlight.size;
  }
}

// Global process-level singleflight instance
const processSingleFlight = new SingleFlight();

/**
 * Acquire a distributed Redis lock.
 *
 * @param {string} key - Cache key
 * @param {Object} options
 * @param {number} [options.lockTtlMs=5000] - Lock expiration in milliseconds
 * @returns {Promise<string|null>} Lock token if acquired, null otherwise
 */
async function acquireLock(key, options = {}) {
  const { lockTtlMs = 5000 } = options;
  const lockKey = `lock:${key}`;
  const token = crypto.randomUUID();

  try {
    const client = cache.getClient();
    if (!client || typeof client.set !== 'function') {
      return token; // fallback in-process
    }

    // SET key token NX PX lockTtlMs
    const result = await client.set(lockKey, token, 'PX', lockTtlMs, 'NX');
    if (result === 'OK' || result === true) {
      return token;
    }
    return null;
  } catch (err) {
    logger.debug('Distributed lock acquire failed or Redis unavailable', {
      key,
      error: err.message,
    });
    // In case of Redis error, fallback gracefully by returning a token
    return token;
  }
}

/**
 * Safely release a distributed Redis lock using token validation.
 *
 * @param {string} key
 * @param {string} token
 * @returns {Promise<boolean>}
 */
async function releaseLock(key, token) {
  if (!token) return false;
  const lockKey = `lock:${key}`;

  try {
    const client = cache.getClient();
    if (!client) return true;

    // Use Lua script to ensure atomic compare-and-delete
    if (typeof client.eval === 'function') {
      const luaScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      const res = await client.eval(luaScript, 1, lockKey, token);
      return res === 1;
    } else if (typeof client.get === 'function' && typeof client.del === 'function') {
      const current = await client.get(lockKey);
      if (current === token) {
        await client.del(lockKey);
        return true;
      }
    }
    return false;
  } catch (err) {
    logger.debug('Distributed lock release failed', { key, error: err.message });
    return false;
  }
}

/**
 * Sleep helper for polling.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cache stampede protection wrapper.
 * Combines singleflight coalescing, distributed locking, and optional background refresh.
 *
 * @param {string} key - Cache key
 * @param {Function} fetcher - Async function to fetch fresh data
 * @param {Object} options
 * @param {number} [options.ttlSeconds=60] - Cache TTL in seconds
 * @param {number} [options.lockTtlMs=5000] - Lock TTL in milliseconds
 * @param {number} [options.lockTimeoutMs=3000] - Max wait time for lock in milliseconds
 * @param {number} [options.retryIntervalMs=50] - Polling interval while waiting for lock
 * @param {boolean} [options.backgroundRefresh=false] - Whether to serve stale value and refresh in background
 * @param {boolean} [options.skipCache=false] - Bypass cache
 * @returns {Promise<*>}
 */
async function fetchWithLock(key, fetcher, options = {}) {
  const {
    ttlSeconds = 60,
    lockTtlMs = 5000,
    lockTimeoutMs = 3000,
    retryIntervalMs = 50,
    backgroundRefresh = false,
    skipCache = false,
  } = options;

  if (typeof fetcher !== 'function') {
    throw new Error('fetchWithLock: fetcher must be a function');
  }

  // 1. If skipCache, execute directly without locking or cache lookup
  if (skipCache) {
    return fetcher();
  }

  // 2. Try cache first
  try {
    const cached = await cache.get(key);
    if (cached !== null && cached !== undefined) {
      const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;

      // Check if wrapper contains metadata for background refresh
      if (parsed && typeof parsed === 'object' && parsed.__stampede_meta) {
        const { value, expiresAt } = parsed;
        const now = Date.now();
        // If expired or near expiration and backgroundRefresh is enabled
        if (now >= expiresAt && backgroundRefresh) {
          // Trigger background refresh asynchronously without blocking caller
          triggerBackgroundRefresh(key, fetcher, { ttlSeconds, lockTtlMs });
          return value;
        }
        return value;
      }

      return parsed;
    }
  } catch (err) {
    logger.debug('Cache get failed during stampede check', { key, error: err.message });
  }

  // 3. Use SingleFlight to coalesce simultaneous in-process calls
  return processSingleFlight.do(key, async () => {
    // Re-check cache in case another in-flight promise just populated it
    try {
      const cached = await cache.get(key);
      if (cached !== null && cached !== undefined) {
        const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
        if (parsed && typeof parsed === 'object' && parsed.__stampede_meta) {
          return parsed.value;
        }
        return parsed;
      }
    } catch {
      // Ignore and proceed
    }

    // 4. Try to acquire distributed lock
    const startTime = Date.now();
    let lockToken = await acquireLock(key, { lockTtlMs });

    // If lock not acquired, wait and poll cache
    while (!lockToken && Date.now() - startTime < lockTimeoutMs) {
      await sleep(retryIntervalMs);

      // Check if the lock holder has populated the cache
      try {
        const cached = await cache.get(key);
        if (cached !== null && cached !== undefined) {
          const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
          if (parsed && typeof parsed === 'object' && parsed.__stampede_meta) {
            return parsed.value;
          }
          return parsed;
        }
      } catch {
        // Ignore and retry
      }

      // Try acquiring lock again
      lockToken = await acquireLock(key, { lockTtlMs });
    }

    // 5. If we have the lock (or timed out waiting, in which case we execute as fallback)
    try {
      const freshData = await fetcher();

      // Store in cache
      try {
        const payloadToStore = backgroundRefresh
          ? {
              __stampede_meta: true,
              value: freshData,
              expiresAt: Date.now() + ttlSeconds * 1000,
            }
          : freshData;

        // Give a generous TTL so background refresh has time to serve stale data
        const storeTtl = backgroundRefresh ? ttlSeconds * 2 : ttlSeconds;
        await cache.set(key, payloadToStore, storeTtl);
      } catch (cacheErr) {
        logger.warn('Failed to populate cache after stampede fetch', {
          key,
          error: cacheErr.message,
        });
      }

      return freshData;
    } finally {
      if (lockToken) {
        await releaseLock(key, lockToken);
      }
    }
  });
}

/**
 * Trigger an asynchronous background refresh under lock.
 */
function triggerBackgroundRefresh(key, fetcher, options = {}) {
  const { ttlSeconds = 60, lockTtlMs = 5000 } = options;

  // Fire and forget
  setImmediate(async () => {
    let lockToken = null;
    try {
      lockToken = await acquireLock(key, { lockTtlMs });
      if (!lockToken) return; // Another worker is already refreshing

      const freshData = await fetcher();
      const payload = {
        __stampede_meta: true,
        value: freshData,
        expiresAt: Date.now() + ttlSeconds * 1000,
      };
      await cache.set(key, payload, ttlSeconds * 2);
      logger.debug('Background cache refresh completed', { key });
    } catch (err) {
      logger.warn('Background cache refresh failed', { key, error: err.message });
    } finally {
      if (lockToken) {
        await releaseLock(key, lockToken);
      }
    }
  });
}

module.exports = {
  SingleFlight,
  processSingleFlight,
  acquireLock,
  releaseLock,
  fetchWithLock,
  triggerBackgroundRefresh,
};
