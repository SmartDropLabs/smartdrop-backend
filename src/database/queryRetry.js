'use strict';

/**
 * Database query retry wrapper (#582).
 *
 * Wraps database queries with automatic retry on transient errors
 * (connection issues, timeouts, deadlocks). Uses exponential backoff
 * with jitter.
 */

const logger = require('../logger');

const RETRYABLE_ERROR_CODES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'PROTOCOL_CONNECTION_LOST',
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT',
  '57P01', // PostgreSQL: admin_shutdown
  '57P02', // PostgreSQL: crash_shutdown
  '57P03', // PostgreSQL: cannot_connect_now
  '40001', // PostgreSQL: serialization_failure
  '40P01', // PostgreSQL: deadlock_detected
];

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 5000;

function isRetryableError(err) {
  if (!err) return false;
  const code = String(err.code || '').toUpperCase();
  if (RETRYABLE_ERROR_CODES.includes(code)) return true;
  const msg = String(err.message || '').toLowerCase();
  return (
    msg.includes('connection') ||
    msg.includes('timeout') ||
    msg.includes('deadlock') ||
    msg.includes('serialization') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset')
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a database query with automatic retry on transient errors.
 *
 * @param {Function} queryFn - Async function that executes the query
 * @param {Object} options - Retry options
 * @param {number} options.maxRetries - Maximum retry attempts (default: 3)
 * @param {number} options.baseDelayMs - Base delay between retries (default: 100ms)
 * @param {number} options.maxDelayMs - Maximum delay between retries (default: 5000ms)
 * @returns {Promise<*>} Query result
 */
async function queryWithRetry(queryFn, options = {}) {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await queryFn();
    } catch (err) {
      lastError = err;

      if (attempt === maxRetries || !isRetryableError(err)) {
        throw err;
      }

      const delay = Math.min(
        baseDelayMs * Math.pow(2, attempt) + Math.random() * baseDelayMs,
        maxDelayMs,
      );

      logger.warn(`Query failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay)}ms`, {
        error: err.message,
        code: err.code,
      });

      await sleep(delay);
    }
  }

  throw lastError;
}

module.exports = {
  queryWithRetry,
  isRetryableError,
  RETRYABLE_ERROR_CODES,
};
