'use strict';

const cache = require('../services/cache');
const config = require('../config');
const logger = require('../logger');
const AppError = require('../errors/AppError');

/**
 * Fixed-window rate limiter backed by Redis INCR + EXPIRE.
 * Fails open if Redis is unreachable so a cache outage cannot lock out users.
 */
// Track consecutive Redis failures per keyPrefix to escalate log severity.
const consecutiveFailures = new Map();

function buildRateLimit({ windowSeconds, max, keyPrefix }) {
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    throw new Error('windowSeconds must be a positive number');
  }
  if (!Number.isFinite(max) || max <= 0) {
    throw new Error('max must be a positive number');
  }
  if (!keyPrefix || typeof keyPrefix !== 'string') {
    throw new Error('keyPrefix is required');
  }

  return async function rateLimit(req, res, next) {
    const identifier = req.ip || req.connection?.remoteAddress || 'unknown';
    const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
    const key = `ratelimit:${keyPrefix}:${identifier}:${bucket}`;

    try {
      const redis = cache.getClient();
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, windowSeconds);
      }
      // Reset failure counter on success.
      consecutiveFailures.delete(keyPrefix);
      const remaining = Math.max(0, max - count);
      const resetAt = (bucket + 1) * windowSeconds;
      const retryAfterSeconds = Math.max(1, resetAt - Math.floor(Date.now() / 1000));
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(remaining));
      res.setHeader('X-RateLimit-Reset', String(resetAt));
      if (count > max) {
        res.setHeader('Retry-After', String(retryAfterSeconds));
        return next(new AppError(
          'RATE_LIMITED',
          `Rate limit of ${max} requests per ${windowSeconds}s exceeded`,
          429,
          { limit: max, window_seconds: windowSeconds, retry_after_seconds: retryAfterSeconds },
        ));
      }
      return next();
    } catch (err) {
      const failures = (consecutiveFailures.get(keyPrefix) || 0) + 1;
      consecutiveFailures.set(keyPrefix, failures);
      // First failure is a warning; 3+ consecutive failures escalate to error
      // so operators see persistent Redis issues in alerting.
      if (failures >= 3) {
        logger.error('Rate limit disabled — Redis error persists', {
          keyPrefix,
          consecutive_failures: failures,
          error: err.message,
        });
      } else {
        logger.warn('Rate limit fail-open due to cache error', { keyPrefix, error: err.message });
      }
      return next();
    }
  };
}

/**
 * Resolves the rate limit tier for an authenticated API key (issue #251).
 *
 * Keys created before tiers existed have no `tier` field, and keys can be
 * created with a tier that was later removed from configuration — both fall
 * back to the default tier rather than being locked out or given unlimited
 * capacity.
 */
function resolveTier(apiKey) {
  const tiers = config.apiKeyRateLimit.tiers;
  const requested = apiKey && typeof apiKey.tier === 'string' ? apiKey.tier : null;
  if (requested && Object.prototype.hasOwnProperty.call(tiers, requested)) {
    return { tier: requested, max: tiers[requested] };
  }
  const fallback = config.apiKeyRateLimit.defaultTier;
  return { tier: fallback, max: tiers[fallback] };
}

/**
 * Per-API-key fixed-window rate limiter (issue #251).
 *
 * The generic `buildRateLimit` above meters every caller of a route into a
 * single IP-keyed bucket, so one abusive API key consumes the capacity of
 * every other key sharing that IP (which, behind a proxy or NAT, is all of
 * them). This limiter gives each key its own bucket, sized by the key's
 * tier, so noisy keys degrade only themselves.
 *
 * Must be mounted after `requireApiKey` — it reads `req.apiKey`. Requests
 * that arrive without an authenticated key are passed through untouched so
 * that public routes and the IP-keyed limiter keep their existing behaviour.
 *
 * Like `buildRateLimit`, it fails open on Redis errors: a cache outage must
 * not lock every API consumer out of the platform.
 */
function buildApiKeyRateLimit({ keyPrefix = 'apikey' } = {}) {
  if (!keyPrefix || typeof keyPrefix !== 'string') {
    throw new Error('keyPrefix is required');
  }

  return async function apiKeyRateLimit(req, res, next) {
    const apiKey = req.apiKey;
    if (!apiKey || !apiKey.id) return next();

    const windowSeconds = config.apiKeyRateLimit.windowSeconds;
    const { tier, max } = resolveTier(apiKey);
    const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
    const key = `ratelimit:${keyPrefix}:${apiKey.id}:${bucket}`;
    const failureKey = `${keyPrefix}:by-key`;

    try {
      const redis = cache.getClient();
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, windowSeconds);
      }
      consecutiveFailures.delete(failureKey);

      const remaining = Math.max(0, max - count);
      const resetAt = (bucket + 1) * windowSeconds;
      const retryAfterSeconds = Math.max(1, resetAt - Math.floor(Date.now() / 1000));
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(remaining));
      res.setHeader('X-RateLimit-Reset', String(resetAt));
      res.setHeader('X-RateLimit-Tier', tier);

      if (count > max) {
        res.setHeader('Retry-After', String(retryAfterSeconds));
        // key_id, not the key itself — the raw key never reaches logs.
        logger.warn('API key rate limit exceeded', {
          key_id: apiKey.id,
          tier,
          limit: max,
          window_seconds: windowSeconds,
        });
        return next(new AppError(
          'RATE_LIMITED',
          `Rate limit of ${max} requests per ${windowSeconds}s exceeded for the ${tier} tier`,
          429,
          {
            limit: max,
            tier,
            window_seconds: windowSeconds,
            retry_after_seconds: retryAfterSeconds,
          },
        ));
      }
      return next();
    } catch (err) {
      const failures = (consecutiveFailures.get(failureKey) || 0) + 1;
      consecutiveFailures.set(failureKey, failures);
      if (failures >= 3) {
        logger.error('Per-key rate limit disabled — Redis error persists', {
          keyPrefix: failureKey,
          consecutive_failures: failures,
          error: err.message,
        });
      } else {
        logger.warn('Per-key rate limit fail-open due to cache error', {
          keyPrefix: failureKey,
          error: err.message,
        });
      }
      return next();
    }
  };
}

module.exports = buildRateLimit;
module.exports.buildRateLimit = buildRateLimit;
module.exports.buildApiKeyRateLimit = buildApiKeyRateLimit;
module.exports.resolveTier = resolveTier;
