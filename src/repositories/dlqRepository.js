'use strict';

/**
 * Dead Letter Queue (DLQ) repository for permanently failed webhook deliveries.
 *
 * Stores failed deliveries in a Redis sorted set keyed by failure timestamp,
 * so entries can be queried chronologically and have automatic TTL cleanup.
 *
 * Schema per entry:
 *   {
 *     id: string,           // delivery ID
 *     webhook_id: string,
 *     event_type: string,
 *     event_id: string,
 *     payload: object,      // full event payload
 *     attempts: number,
 *     errors: string[],     // error history across all attempts
 *     last_error: string,
 *     response_status: number | null,
 *     trace_id: string,
 *     failed_at: string,    // ISO timestamp
 *   }
 */

const cache = require('../services/cache');
const logger = require('../logger');

const DLQ_KEY = 'webhooks:dlq';
const DLQ_ENTRY_PREFIX = 'webhook:dlq:';
// Default TTL: 7 days
const DEFAULT_DLQ_TTL_SECONDS = 7 * 24 * 60 * 60;
// Max entries to keep in DLQ
const MAX_DLQ_ENTRIES = 1000;

function entryKey(deliveryId) {
  return `${DLQ_ENTRY_PREFIX}${deliveryId}`;
}

/**
 * Add a permanently failed delivery to the DLQ.
 *
 * @param {object} delivery - The failed delivery record
 * @param {string[]} errors - Array of error messages from all attempts
 * @param {object|null} payload - The full event payload
 */
async function addToDLQ(delivery, errors, payload) {
  const redis = cache.getClient();
  const entry = {
    id: delivery.id,
    webhook_id: delivery.webhook_id,
    event_type: delivery.event_type,
    event_id: delivery.event_id,
    payload: payload || delivery.payload || null,
    attempts: delivery.attempts || 0,
    errors: errors || [],
    last_error: delivery.last_error || 'unknown',
    response_status: delivery.response_status || null,
    trace_id: delivery.trace_id || null,
    failed_at: new Date().toISOString(),
  };

  const now = Date.now();
  await redis.zadd(DLQ_KEY, now, delivery.id);
  await cache.set(entryKey(delivery.id), entry, DEFAULT_DLQ_TTL_SECONDS);

  // Trim oldest entries if we exceed the max
  const count = await redis.zcard(DLQ_KEY);
  if (count > MAX_DLQ_ENTRIES) {
    const toRemove = await redis.zrange(DLQ_KEY, 0, count - MAX_DLQ_ENTRIES - 1);
    if (toRemove.length > 0) {
      await redis.zrem(DLQ_KEY, ...toRemove);
      // Clean up entry keys
      for (const id of toRemove) {
        await cache.del(entryKey(id));
      }
    }
  }

  logger.info('Delivery added to DLQ', {
    delivery_id: delivery.id,
    webhook_id: delivery.webhook_id,
    event_type: delivery.event_type,
    attempts: delivery.attempts,
  });

  return entry;
}

/**
 * List DLQ entries, most recent first.
 *
 * @param {object} options
 * @param {number} options.limit - Max entries to return (default 50)
 * @param {number} options.offset - Pagination offset (default 0)
 * @returns {Promise<{entries: object[], total: number}>}
 */
async function list({ limit = 50, offset = 0 } = {}) {
  const redis = cache.getClient();
  const total = await redis.zcard(DLQ_KEY);
  const ids = await redis.zrevrange(DLQ_KEY, offset, offset + limit - 1);

  if (ids.length === 0) {
    return { entries: [], total };
  }

  const entries = await Promise.all(
    ids.map(async (id) => {
      const entry = await cache.get(entryKey(id));
      if (!entry) {
        // Entry expired or was cleaned up; remove stale reference
        await redis.zrem(DLQ_KEY, id);
        return null;
      }
      return entry;
    })
  );

  return { entries: entries.filter(Boolean), total };
}

/**
 * Get a single DLQ entry by delivery ID.
 *
 * @param {string} deliveryId
 * @returns {Promise<object|null>}
 */
async function getById(deliveryId) {
  return cache.get(entryKey(deliveryId));
}

/**
 * Remove a delivery from the DLQ (after successful retry or manual dismissal).
 *
 * @param {string} deliveryId
 * @returns {Promise<boolean>}
 */
async function remove(deliveryId) {
  const redis = cache.getClient();
  const removed = await redis.zrem(DLQ_KEY, deliveryId);
  await cache.del(entryKey(deliveryId));
  return removed > 0;
}

/**
 * Count total entries in the DLQ.
 *
 * @returns {Promise<number>}
 */
async function count() {
  const redis = cache.getClient();
  return redis.zcard(DLQ_KEY);
}

module.exports = {
  addToDLQ,
  list,
  getById,
  remove,
  count,
};
