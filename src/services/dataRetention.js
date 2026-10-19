'use strict';

/**
 * Data retention policies service (#567).
 *
 * Manages automatic cleanup of old records based on configured retention periods.
 * Prevents storage bloat and helps with compliance/privacy concerns.
 */

const cache = require('./cache');
const logger = require('../logger');

function getEnvNumber(key, defaultValue) {
  const val = process.env[key];
  if (val !== undefined && val !== '') {
    const num = Number(val);
    if (Number.isSafeInteger(num) && num > 0) return num;
  }
  return defaultValue;
}

const DELIVERY_RETENTION_DAYS = getEnvNumber('DELIVERY_LOG_RETENTION_DAYS', 30);
const SESSION_RETENTION_DAYS = getEnvNumber('SESSION_RETENTION_DAYS', 7);

const DELIVERY_TTL_MS = DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Applies retention policy to a cache record by setting its TTL.
 * Records older than the retention period are automatically removed by Redis.
 *
 * @param {string} key - Cache key
 * @param {number} ttlSeconds - TTL in seconds
 * @returns {Promise<void>}
 */
async function applyRetentionPolicy(key, ttlSeconds) {
  try {
    const redis = cache.getClient();
    if (redis) {
      await redis.expire(key, ttlSeconds);
    }
  } catch (err) {
    logger.warn('Failed to apply retention policy', { key, error: err.message });
  }
}

/**
 * Applies delivery log retention policy.
 * Keeps delivery records for the configured retention period.
 *
 * @param {string} deliveryId - Delivery ID
 * @returns {Promise<void>}
 */
async function applyDeliveryRetention(deliveryId) {
  await applyRetentionPolicy(`webhook_delivery:${deliveryId}`, DELIVERY_RETENTION_DAYS * 24 * 60 * 60);
}

/**
 * Applies session retention policy.
 * Expires old session records to prevent unbounded accumulation.
 *
 * @param {string} sessionId - Session ID
 * @returns {Promise<void>}
 */
async function applySessionRetention(sessionId) {
  await applyRetentionPolicy(`session:${sessionId}`, SESSION_RETENTION_DAYS * 24 * 60 * 60);
}

/**
 * Cleanup callback for removing expired records from secondary indexes.
 * Called when a record expires, removes its entries from any associated indexes.
 *
 * @param {string} recordKey - The key of the expired record
 * @returns {Promise<void>}
 */
async function cleanupExpiredRecordIndexes(recordKey) {
  try {
    const redis = cache.getClient();
    if (!redis) return;

    if (recordKey.startsWith('webhook_delivery:')) {
      const deliveryId = recordKey.substring('webhook_delivery:'.length);
      const pattern = `webhook:*:deliveries*`;
      const scan = (cursor) =>
        redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);

      let nextCursor = '0';
      do {
        const [cursor, keys] = await scan(nextCursor);
        nextCursor = cursor;

        if (keys.length > 0) {
          const pipeline = redis.multi();
          keys.forEach((key) => {
            pipeline.zrem(key, deliveryId);
          });
          await pipeline.exec();
        }
      } while (nextCursor !== '0');
    }
  } catch (err) {
    logger.warn('Cleanup of record indexes failed', { recordKey, error: err.message });
  }
}

module.exports = {
  DELIVERY_RETENTION_DAYS,
  SESSION_RETENTION_DAYS,
  DELIVERY_TTL_MS,
  SESSION_TTL_MS,
  applyRetentionPolicy,
  applyDeliveryRetention,
  applySessionRetention,
  cleanupExpiredRecordIndexes,
};
