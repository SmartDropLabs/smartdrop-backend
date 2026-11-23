'use strict';

const crypto = require('crypto');
const Sentry = require('@sentry/node');
const config = require('../config');
const cache = require('./cache');

let initialized = false;
const errorGroups = new Map();

/**
 * Supported severity levels, ordered from least to most severe (#686).
 */
const SEVERITY_LEVELS = Object.freeze(['info', 'warning', 'error', 'critical']);

/**
 * Map internal severity levels to Sentry's level names (#686).
 * Sentry uses "fatal" for the highest level.
 */
const SENTRY_LEVEL_MAP = Object.freeze({
  info: 'info',
  warning: 'warning',
  error: 'error',
  critical: 'fatal',
});

const CRITICAL_ERROR_NAMES = new Set(['FatalError', 'OutOfMemoryError']);

function init() {
  const dsn = config.sentryDsn || process.env.SENTRY_DSN;
  if (dsn) {
    const isProduction = (config.nodeEnv || 'development') === 'production';
    Sentry.init({
      dsn,
      environment: config.nodeEnv || 'development',
      tracesSampleRate: isProduction ? 0.1 : 1.0,
    });
    initialized = true;
  }
  return initialized;
}

function isInitialized() {
  return initialized;
}

/**
 * Coerce a value to a valid severity level, falling back to "error" (#686).
 *
 * @param {string} severity
 * @returns {string} One of SEVERITY_LEVELS
 */
function normalizeSeverity(severity) {
  return SEVERITY_LEVELS.includes(severity) ? severity : 'error';
}

/**
 * Classify an error into a severity level (#686).
 *
 * Precedence:
 *   1. An explicit, valid `error.severity` value
 *   2. `error.critical === true` or a known fatal error name -> critical
 *   3. HTTP-style status (`status` / `statusCode`): 5xx -> error, 4xx -> warning
 *   4. Default -> error
 *
 * @param {Error|Object|string} error
 * @returns {string} One of SEVERITY_LEVELS
 */
function classifyError(error) {
  if (!error || typeof error !== 'object') return 'error';
  if (SEVERITY_LEVELS.includes(error.severity)) return error.severity;
  if (error.critical === true || CRITICAL_ERROR_NAMES.has(error.name)) return 'critical';

  const status = Number(error.status || error.statusCode);
  if (status >= 500) return 'error';
  if (status >= 400) return 'warning';

  return 'error';
}

/**
 * Generate a deterministic fingerprint hash for an error (#637).
 * Groups similar errors together based on error name, normalized message,
 * and top stack frames.
 *
 * @param {Error|Object|string} error
 * @returns {string} Fingerprint hash
 */
function hashError(error) {
  if (!error) return 'unknown_error';
  const name = error.name || (error.constructor && error.constructor.name) || 'Error';
  const rawMsg = error.message || String(error);
  // Normalize variable tokens (UUIDs, IP addresses, timestamps, numbers) to cluster recurring patterns
  const normalizedMsg = rawMsg
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '<ip>')
    .replace(/\b\d+\b/g, '<num>');
  const topStack = (error.stack || '')
    .split('\n')
    .slice(1, 4)
    .join('\n')
    .replace(/:\d+:\d+/g, '')
    .replace(/\b\d+\b/g, '<num>');
  return crypto
    .createHash('sha256')
    .update(`${name}:${normalizedMsg}:${topStack}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Increment the occurrence count for an error group fingerprint (#637).
 *
 * @param {string} fingerprint
 * @param {Error|Object} error
 * @param {string} [severity] Severity level; defaults to classifyError(error) (#686)
 * @returns {Promise<Object>} Updated group info
 */
async function incrementGroup(fingerprint, error, severity) {
  const now = Date.now();
  const resolvedSeverity = normalizeSeverity(severity || classifyError(error));
  let group = errorGroups.get(fingerprint);
  if (!group) {
    group = {
      fingerprint,
      name: error?.name || 'Error',
      message: error?.message || String(error),
      severity: resolvedSeverity,
      count: 0,
      firstSeen: now,
      lastSeen: now,
    };
  }
  group.severity = resolvedSeverity;
  group.count += 1;
  group.lastSeen = now;
  errorGroups.set(fingerprint, group);

  try {
    const redis = cache.getClient ? cache.getClient() : null;
    if (redis && typeof redis.hincrby === 'function') {
      const redisKey = `error_group:${fingerprint}`;
      await redis.hincrby(redisKey, 'count', 1);
      await redis.hset(
        redisKey,
        'lastSeen',
        String(now),
        'message',
        group.message,
        'severity',
        resolvedSeverity
      );
    }
  } catch (err) {
    // Non-blocking fallback
  }

  return group;
}

/**
 * Retrieve current statistics for an error group.
 * @param {string} fingerprint
 * @returns {Object|null}
 */
function getErrorGroup(fingerprint) {
  return errorGroups.get(fingerprint) || null;
}

function captureException(error, context = {}) {
  if (!error) return null;

  const fingerprint = hashError(error);
  const severity = normalizeSeverity(classifyError(error));
  incrementGroup(fingerprint, error, severity).catch(() => {});

  if (initialized) {
    return Sentry.captureException(error, {
      level: SENTRY_LEVEL_MAP[severity],
      extra: { ...context, fingerprint, severity },
      fingerprint: [fingerprint],
    });
  }
  return fingerprint;
}

/**
 * Track an error with an explicit or classified severity (#686).
 *
 * @param {Object} params
 * @param {Error|Object|string} params.error
 * @param {string} [params.severity] One of SEVERITY_LEVELS; classified if omitted
 * @param {number} [params.timestamp] Epoch milliseconds; defaults to now
 * @returns {string|null} Error fingerprint, or null if no error was given
 */
function track({ error, severity, timestamp = Date.now() } = {}) {
  if (!error) return null;

  const fingerprint = hashError(error);
  const resolvedSeverity = normalizeSeverity(severity || classifyError(error));
  incrementGroup(fingerprint, error, resolvedSeverity).catch(() => {});

  if (initialized) {
    Sentry.captureException(error, {
      level: SENTRY_LEVEL_MAP[resolvedSeverity],
      extra: { fingerprint, severity: resolvedSeverity, timestamp },
      fingerprint: [fingerprint],
    });
  }
  return fingerprint;
}

function captureMessage(message, level = 'info', context = {}) {
  if (!message) return null;

  if (initialized) {
    return Sentry.captureMessage(message, { level, extra: context });
  }
  return null;
}

// Auto-initialize on import if SENTRY_DSN is present in environment/config
init();

module.exports = {
  init,
  isInitialized,
  captureException,
  captureMessage,
  hashError,
  incrementGroup,
  getErrorGroup,
  classifyError,
  track,
  SEVERITY_LEVELS,
};
