"use strict";

/**
 * Database query retry wrapper (#582).
 *
 * Wraps database queries with automatic retry on transient errors
 * (connection issues, timeouts, deadlocks). Uses exponential backoff
 * with jitter.
 */

const logger = require("../logger");

const RETRYABLE_ERROR_CODES = [
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "PROTOCOL_CONNECTION_LOST",
  "ER_LOCK_DEADLOCK",
  "ER_LOCK_WAIT_TIMEOUT",
  "57P01", // PostgreSQL: admin_shutdown
  "57P02", // PostgreSQL: crash_shutdown
  "57P03", // PostgreSQL: cannot_connect_now
  "40001", // PostgreSQL: serialization_failure
  "40P01", // PostgreSQL: deadlock_detected
];

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 5000;
const CIRCUIT_BREAKER_THRESHOLD = 5; // Open circuit after 5 consecutive failures
const CIRCUIT_BREAKER_COOLDOWN_MS = 30000; // 30 seconds cooldown

// Circuit breaker state
let failureCount = 0;
let circuitOpen = false;
let cooldownUntil = 0;

/**
 * Check if circuit breaker is open.
 * @returns {boolean} True if circuit is open and should block requests
 */
function isCircuitOpen() {
  if (!circuitOpen) return false;

  const now = Date.now();
  if (now >= cooldownUntil) {
    // Cooldown period expired, try half-open state
    logger.info("Circuit breaker entering half-open state (cooldown expired)");
    circuitOpen = false;
    failureCount = 0;
    return false;
  }

  return true;
}

/**
 * Record a successful query execution.
 * Resets failure count and closes circuit if open.
 */
function recordSuccess() {
  if (failureCount > 0 || circuitOpen) {
    logger.info("Circuit breaker: query succeeded, resetting failure count");
    failureCount = 0;
    circuitOpen = false;
    cooldownUntil = 0;
  }
}

/**
 * Record a failed query execution.
 * Opens circuit breaker if threshold is exceeded.
 */
function recordFailure() {
  failureCount++;

  if (failureCount >= CIRCUIT_BREAKER_THRESHOLD && !circuitOpen) {
    circuitOpen = true;
    cooldownUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
    logger.error("Circuit breaker opened due to repeated failures", {
      failureCount,
      cooldownMs: CIRCUIT_BREAKER_COOLDOWN_MS,
      cooldownUntil: new Date(cooldownUntil).toISOString(),
    });
  }
}

function isRetryableError(err) {
  if (!err) return false;
  const code = String(err.code || "").toUpperCase();
  if (RETRYABLE_ERROR_CODES.includes(code)) return true;
  const msg = String(err.message || "").toLowerCase();
  return (
    msg.includes("connection") ||
    msg.includes("timeout") ||
    msg.includes("deadlock") ||
    msg.includes("serialization") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset")
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Record a retry attempt in Prometheus metrics (#719).
 * The metrics module is required lazily to avoid a load-time cycle, and any
 * metrics failure is swallowed so it can never affect the query itself.
 * @param {Error} err - The error that triggered the retry
 * @param {number} delayMs - Backoff delay before the retry
 */
function recordRetryMetrics(err, delayMs) {
  try {
    const { dbQueryRetriesTotal, dbQueryRetryDelaySeconds } = require("../metrics");
    const code = String(err.code || "").toUpperCase();
    // Bounded label set: known codes only, everything else is "other"
    dbQueryRetriesTotal.inc({
      code: RETRYABLE_ERROR_CODES.includes(code) ? code : "other",
    });
    dbQueryRetryDelaySeconds.observe({}, delayMs / 1000);
  } catch {
    // Metrics are best-effort
  }
}

/**
 * Execute a database query with automatic retry on transient errors.
 * Implements circuit breaker pattern to stop retrying when database is down.
 *
 * @param {Function} queryFn - Async function that executes the query
 * @param {Object} options - Retry options
 * @param {number} options.maxRetries - Maximum retry attempts (default: 3)
 * @param {number} options.baseDelayMs - Base delay between retries (default: 100ms)
 * @param {number} options.maxDelayMs - Maximum delay between retries (default: 5000ms)
 * @param {boolean} options.skipCircuitBreaker - Skip circuit breaker check (default: false)
 * @returns {Promise<*>} Query result
 * @throws {Error} If circuit breaker is open or query fails after retries
 */
async function queryWithRetry(queryFn, options = {}) {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    skipCircuitBreaker = false,
  } = options;

  // Check circuit breaker before attempting query
  if (!skipCircuitBreaker && isCircuitOpen()) {
    const err = new Error(
      "Circuit breaker is open - database appears to be down",
    );
    err.code = "CIRCUIT_BREAKER_OPEN";
    err.cooldownUntil = new Date(cooldownUntil).toISOString();
    throw err;
  }

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await queryFn();
      recordSuccess();
      return result;
    } catch (err) {
      lastError = err;

      if (attempt === maxRetries || !isRetryableError(err)) {
        recordFailure();
        throw err;
      }

      const delay = Math.min(
        baseDelayMs * Math.pow(2, attempt) + Math.random() * baseDelayMs,
        maxDelayMs,
      );

      recordRetryMetrics(err, delay);

      logger.warn(
        `Query failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay)}ms`,
        {
          error: err.message,
          code: err.code,
          failureCount: failureCount + 1,
        },
      );

      await sleep(delay);
    }
  }

  recordFailure();
  throw lastError;
}

module.exports = {
  queryWithRetry,
  isRetryableError,
  isCircuitOpen,
  recordSuccess,
  recordFailure,
  RETRYABLE_ERROR_CODES,
  CIRCUIT_BREAKER_THRESHOLD,
  CIRCUIT_BREAKER_COOLDOWN_MS,
};
