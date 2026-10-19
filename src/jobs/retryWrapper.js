'use strict';

const logger = require('../logger');
const AppError = require('../errors/AppError');

/**
 * #457 — Background job retry wrapper with exponential backoff and jitter.
 *
 * Requirements:
 * - Configurable maximum number of attempts with exponential backoff + jitter.
 * - Only retry errors that are plausibly transient (network, 5xx, timeouts, 429).
 * - Do NOT retry permanent errors (validation, 4xx client errors, syntax/type errors).
 * - Exhausted retries end up in a clearly logged failed state and dead-letter registry.
 * - Log each attempt with job name, attempt number, and error.
 * - Non-idempotent jobs must not be blindly retried.
 */

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY_MS = 1000;
const DEFAULT_BACKOFF_FACTOR = 2;
const DEFAULT_MAX_DELAY_MS = 30000;

// Dead-letter registry for jobs that exhausted all retry attempts
const deadLetterRegistry = [];

/**
 * Check whether an error is plausibly transient.
 *
 * Transient errors include:
 * - Network errors (ECONNRESET, ETIMEDOUT, ECONNREFUSED, EHOSTUNREACH, ENOTFOUND, EAI_AGAIN, EPIPE)
 * - Server errors (HTTP 500, 502, 503, 504)
 * - Rate limits (HTTP 429)
 * - Explicitly marked transient errors
 *
 * Non-transient errors (permanent) include:
 * - Validation errors (AppError 400, 422)
 * - Authentication/authorization errors (401, 403)
 * - Not found errors (404)
 * - Syntax, Type, or Reference errors
 * - Explicitly marked non-retryable errors
 */
function isTransientError(err) {
  if (!err) return false;

  // Explicit non-retryable flag
  if (err.nonRetryable || err.isPermanent) return false;

  // AppError status code checks
  if (err instanceof AppError || typeof err.statusCode === 'number') {
    const status = err.statusCode || err.status;
    if (status === 429) return true; // Rate limit is transient
    if (status >= 400 && status < 500) return false; // 4xx client errors are permanent
    if (status >= 500) return true; // 5xx server errors are transient
  }

  // Axios or HTTP response status checks
  if (err.response && typeof err.response.status === 'number') {
    const status = err.response.status;
    if (status === 429) return true;
    if (status >= 400 && status < 500) return false;
    if (status >= 500) return true;
  }

  // Common transient network error codes
  const transientCodes = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
  ]);

  if (err.code && transientCodes.has(err.code)) {
    return true;
  }

  // Standard JavaScript language runtime errors are permanent bugs
  if (
    err instanceof TypeError ||
    err instanceof RangeError ||
    err instanceof SyntaxError ||
    err instanceof ReferenceError
  ) {
    return false;
  }

  // Message pattern matching for transient errors
  const transientMessagePatterns = [
    /timeout/i,
    /timed out/i,
    /connection reset/i,
    /connection refused/i,
    /network error/i,
    /socket hang up/i,
    /rate limit/i,
    /temporarily unavailable/i,
  ];

  return transientMessagePatterns.some((pattern) => pattern.test(err.message || ''));
}

/**
 * Calculate exponential backoff delay with random jitter.
 */
function calculateBackoffDelay(attempt, options = {}) {
  const initialDelay = options.initialDelayMs || DEFAULT_INITIAL_DELAY_MS;
  const factor = options.backoffFactor || DEFAULT_BACKOFF_FACTOR;
  const maxDelay = options.maxDelayMs || DEFAULT_MAX_DELAY_MS;

  // Exponential backoff
  const exponentialDelay = initialDelay * Math.pow(factor, attempt - 1);
  const cappedDelay = Math.min(exponentialDelay, maxDelay);

  // Add jitter (between 0% and 25% of the calculated delay)
  const jitterAmount = options.disableJitter
    ? 0
    : Math.floor(Math.random() * (cappedDelay * 0.25));

  return cappedDelay + jitterAmount;
}

/**
 * Execute a job function with retry capabilities.
 *
 * @param {string} jobName - Name of the background job for logging/telemetry
 * @param {Function} jobFn - Async function to execute
 * @param {Object} [options]
 * @param {number} [options.maxAttempts=3] - Maximum retry attempts
 * @param {number} [options.initialDelayMs=1000] - Initial delay before first retry
 * @param {number} [options.backoffFactor=2] - Exponential multiplier
 * @param {number} [options.maxDelayMs=30000] - Maximum delay cap
 * @param {boolean} [options.isIdempotent=true] - Guard against retrying non-idempotent operations
 * @param {Function} [options.onAttemptFailure] - Hook called on each failure
 * @returns {Promise<*>} Result of jobFn
 */
async function runWithRetry(jobName, jobFn, options = {}) {
  const maxAttempts = options.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  const isIdempotent = options.isIdempotent !== false;

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await jobFn(attempt);
    } catch (err) {
      lastError = err;

      // Log the attempt failure
      logger.warn('Background job attempt failed', {
        job: jobName,
        attempt,
        maxAttempts,
        error: err.message,
      });

      if (typeof options.onAttemptFailure === 'function') {
        options.onAttemptFailure({ jobName, attempt, error: err });
      }

      // Check if this error is non-retryable
      if (!isTransientError(err)) {
        logger.error('Background job encountered permanent error — skipping retries', {
          job: jobName,
          attempt,
          error: err.message,
        });
        throw err;
      }

      // Guard: do not retry non-idempotent jobs that could duplicate side effects
      if (!isIdempotent) {
        logger.error('Background job is not marked as idempotent — skipping retries to prevent duplicate side effects', {
          job: jobName,
          attempt,
        });
        throw err;
      }

      // If attempts exhausted, break to dead-letter state
      if (attempt >= maxAttempts) {
        break;
      }

      // Calculate delay with backoff and jitter
      const delayMs = calculateBackoffDelay(attempt, options);
      logger.info('Scheduling background job retry', {
        job: jobName,
        nextAttempt: attempt + 1,
        delayMs,
      });

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // Retries exhausted — record in dead-letter registry and log clearly
  const failedEntry = {
    jobName,
    error: lastError ? lastError.message : 'Unknown error',
    attempts: maxAttempts,
    failedAt: new Date().toISOString(),
  };

  deadLetterRegistry.push(failedEntry);
  // Keep dead-letter list bounded
  if (deadLetterRegistry.length > 500) {
    deadLetterRegistry.shift();
  }

  logger.error('Background job exhausted all retry attempts, marked as FAILED', failedEntry);

  const exhaustedError = new Error(
    `Job "${jobName}" failed after ${maxAttempts} attempts: ${lastError?.message}`
  );
  exhaustedError.originalError = lastError;
  exhaustedError.jobName = jobName;
  exhaustedError.attempts = maxAttempts;
  exhaustedError.isExhausted = true;

  throw exhaustedError;
}

/**
 * Wrap a periodic or triggerable job module with automatic retry logic.
 *
 * @param {Object} jobModule - Job object with tick() or run() method
 * @param {string} jobName - Name of the job
 * @param {Object} [options] - Retry options
 * @returns {Object} Wrapped job module
 */
function createRetryableJob(jobModule, jobName, options = {}) {
  const originalTick = jobModule.tick || jobModule.run;
  if (typeof originalTick !== 'function') {
    throw new Error(`createRetryableJob: job "${jobName}" must expose a tick() or run() function`);
  }

  const wrappedTick = async (...args) => {
    return runWithRetry(jobName, () => originalTick.apply(jobModule, args), options);
  };

  return {
    ...jobModule,
    tick: wrappedTick,
    run: wrappedTick,
  };
}

/**
 * Get current dead-letter failed jobs list.
 */
function getDeadLetterJobs() {
  return [...deadLetterRegistry];
}

/**
 * Clear the dead-letter list (useful in tests).
 */
function clearDeadLetterJobs() {
  deadLetterRegistry.length = 0;
}

module.exports = {
  calculateBackoffDelay,
  clearDeadLetterJobs,
  createRetryableJob,
  getDeadLetterJobs,
  isTransientError,
  runWithRetry,
};
