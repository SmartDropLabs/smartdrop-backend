'use strict';

/**
 * Data retention policies service (#567, #685).
 *
 * Manages automatic cleanup of old records based on configured retention periods.
 * Prevents storage bloat and helps with compliance/privacy concerns.
 *
 * Retention periods are configured per table (collection) in `policies`. Each
 * policy can be overridden with an environment variable; invalid or missing
 * values fall back to the default for that table.
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

/**
 * Per-table retention policies, in days.
 *
 * - webhook_delivery: webhook delivery logs (DELIVERY_LOG_RETENTION_DAYS)
 * - session: session records (SESSION_RETENTION_DAYS)
 * - audit_logs: audit log entries (AUDIT_LOG_RETENTION_DAYS)
 * - temp_files: temporary file records (TEMP_FILE_RETENTION_DAYS)
 */
const policies = Object.freeze({
  webhook_delivery: getEnvNumber('DELIVERY_LOG_RETENTION_DAYS', 30),
  session: getEnvNumber('SESSION_RETENTION_DAYS', 7),
  audit_logs: getEnvNumber('AUDIT_LOG_RETENTION_DAYS', 90),
  temp_files: getEnvNumber('TEMP_FILE_RETENTION_DAYS', 7),
});

/**
 * Returns the retention period in days for a table.
 *
 * @param {string} table - Table/collection name (a key of `policies`)
 * @returns {number|undefined} Retention period in days, or undefined for unknown tables
 */
function getRetentionDays(table) {
  return Object.prototype.hasOwnProperty.call(policies, table) ? policies[table] : undefined;
}

const DELIVERY_RETENTION_DAYS = policies.webhook_delivery;
const SESSION_RETENTION_DAYS = policies.session;

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
  await applyRetentionPolicy(`webhook_delivery:${deliveryId}`, getRetentionDays('webhook_delivery') * 24 * 60 * 60);
}

/**
 * Applies session retention policy.
 * Expires old session records to prevent unbounded accumulation.
 *
 * @param {string} sessionId - Session ID
 * @returns {Promise<void>}
 */
async function applySessionRetention(sessionId) {
  await applyRetentionPolicy(`session:${sessionId}`, getRetentionDays('session') * 24 * 60 * 60);
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

/**
 * Find expired records across retention collections (#632).
 *
 * @param {Object} [options]
 * @returns {Promise<Array<string>>} List of expired record keys
 */
async function findExpired(options = {}) {
  const expired = [];
  try {
    const redis = cache.getClient();
    if (!redis) return expired;

    // Scan for delivery logs or session keys
    const patterns = ['webhook_delivery:*', 'session:*'];
    for (const pattern of patterns) {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        for (const key of keys) {
          const ttl = await redis.ttl(key);
          // If key has expired or negative TTL (except -1 no expiry, -2 non-existent)
          if (ttl <= 0 && ttl !== -1) {
            expired.push(key);
          }
        }
      } while (cursor !== '0');
    }
  } catch (err) {
    logger.warn('Error finding expired retention records', { error: err.message });
  }
  return expired;
}

/**
 * Delete records by key.
 *
 * @param {Array<string>} records
 * @returns {Promise<number>} Number of deleted records
 */
async function deleteRecords(records) {
  if (!records || records.length === 0) return 0;
  const redis = cache.getClient();
  if (!redis) return 0;

  const pipeline = redis.multi();
  for (const item of records) {
    const key = typeof item === 'string' ? item : item.key || item.id;
    pipeline.del(key);
  }
  await pipeline.exec();
  return records.length;
}

/**
 * Run data retention policies with optional dry-run mode (#632).
 *
 * @param {boolean|Object} [dryRunOrOptions=false] - When true, computes records without deleting
 * @returns {Promise<Object>} Execution summary
 */
async function runRetention(dryRunOrOptions = false) {
  const dryRun = typeof dryRunOrOptions === 'boolean' ? dryRunOrOptions : !!dryRunOrOptions?.dryRun;
  const toDelete = await findExpired();

  if (dryRun) {
    logger.info(`Retention dry-run: would delete ${toDelete.length} records`);
    console.log(`Would delete ${toDelete.length} records`);
    return {
      dryRun: true,
      count: toDelete.length,
      wouldDelete: toDelete,
    };
  }

  const deletedCount = await deleteRecords(toDelete);
  logger.info(`Retention run: deleted ${deletedCount} records`);
  return {
    dryRun: false,
    count: deletedCount,
  };
}

module.exports = {
  policies,
  getRetentionDays,
  DELIVERY_RETENTION_DAYS,
  SESSION_RETENTION_DAYS,
  DELIVERY_TTL_MS,
  SESSION_TTL_MS,
  applyRetentionPolicy,
  applyDeliveryRetention,
  applySessionRetention,
  cleanupExpiredRecordIndexes,
  findExpired,
  deleteRecords,
  runRetention,
};
