'use strict';

const crypto = require('crypto');
const Sentry = require('@sentry/node');
const config = require('../config');
const cache = require('./cache');

let initialized = false;
const errorGroups = new Map();

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
 * @returns {Promise<Object>} Updated group info
 */
async function incrementGroup(fingerprint, error) {
  const now = Date.now();
  let group = errorGroups.get(fingerprint);
  if (!group) {
    group = {
      fingerprint,
      name: error?.name || 'Error',
      message: error?.message || String(error),
      count: 0,
      firstSeen: now,
      lastSeen: now,
    };
  }
  group.count += 1;
  group.lastSeen = now;
  errorGroups.set(fingerprint, group);

  try {
    const redis = cache.getClient ? cache.getClient() : null;
    if (redis && typeof redis.hincrby === 'function') {
      const redisKey = `error_group:${fingerprint}`;
      await redis.hincrby(redisKey, 'count', 1);
      await redis.hset(redisKey, 'lastSeen', String(now), 'message', group.message);
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
  incrementGroup(fingerprint, error).catch(() => {});

  if (initialized) {
    return Sentry.captureException(error, {
      extra: { ...context, fingerprint },
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
};
