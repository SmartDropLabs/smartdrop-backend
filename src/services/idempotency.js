const cache = require('./cache');
const logger = require('../logger');

const IDEMPOTENCY_KEY_PREFIX = 'idempotency:';
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60; // 24 hours

/**
 * Check if an idempotency key was already processed and return the cached response
 * 
 * @param {string} key - The idempotency key
 * @returns {Promise<Object|null>} Cached response data if exists, null otherwise
 */
async function getIdempotencyResponse(key) {
  if (!key) return null;
  
  try {
    const cacheKey = `${IDEMPOTENCY_KEY_PREFIX}${key}`;
    // cache.get() already JSON.parses the stored value, so `cached` here is
    // a plain object, not a string — re-parsing it throws (issue #316).
    const cached = await cache.get(cacheKey);
    return cached || null;
  } catch (err) {
    logger.warn('Failed to retrieve idempotency response', { key, error: err.message });
    return null;
  }
}

/**
 * Store a response for an idempotency key
 * 
 * @param {string} key - The idempotency key
 * @param {number} statusCode - HTTP status code
 * @param {Object} responseBody - Response body to cache
 */
async function storeIdempotencyResponse(key, statusCode, responseBody) {
  if (!key) return;
  
  try {
    const cacheKey = `${IDEMPOTENCY_KEY_PREFIX}${key}`;
    const data = {
      statusCode,
      body: responseBody,
      timestamp: new Date().toISOString(),
    };
    // cache.set() already JSON.stringifies the value and supports a TTL;
    // cache.setex() isn't a method this module exports (issue #316).
    await cache.set(cacheKey, data, IDEMPOTENCY_TTL_SECONDS);
  } catch (err) {
    logger.error('Failed to store idempotency response', { key, error: err.message });
  }
}

/**
 * Middleware to handle idempotency for POST requests
 * 
 * Checks for Idempotency-Key header and:
 * - Returns cached response if key was already processed
 * - Stores response if this is a new key
 * 
 * To use, call with the resource type:
 *   app.post('/webhooks', idempotencyMiddleware('webhook'), ...)
 */
function idempotencyMiddleware(resourceType = 'resource') {
  return async (req, res, next) => {
    const idempotencyKey = req.get('Idempotency-Key');

    // Validate idempotency key format before processing
    if (idempotencyKey && typeof idempotencyKey !== 'string') {
      return res.status(400).json({ error: 'Invalid Idempotency-Key header' });
    }

    if (idempotencyKey && idempotencyKey.length === 0) {
      return res.status(400).json({ error: 'Idempotency-Key header cannot be empty' });
    }

    // Check if this idempotency key was already processed before any other processing
    if (idempotencyKey) {
      const cached = await getIdempotencyResponse(idempotencyKey);
      if (cached) {
        // Return the cached response
        res.set('Idempotency-Replay', 'true');
        return res.status(cached.statusCode).json(cached.body);
      }
    }

    // Store the original json() method
    const originalJson = res.json.bind(res);

    // Override json() to capture and cache the response only after request is processed successfully
    res.json = function(data) {
      if (idempotencyKey && res.statusCode >= 200 && res.statusCode < 300) {
        // Only cache successful responses
        storeIdempotencyResponse(idempotencyKey, res.statusCode, data);
      }
      return originalJson(data);
    };

    // Mark that we're processing this key
    if (idempotencyKey) {
      res.set('Idempotency-Key', idempotencyKey);
    }

    return next();
  };
}

module.exports = {
  idempotencyMiddleware,
  getIdempotencyResponse,
  storeIdempotencyResponse,
};
