'use strict';

/**
 * Session management service with server-side expiry enforcement (Issue #469).
 *
 * Enforces dual-window expiry:
 * 1. Absolute lifetime: fixed maximum session duration that activity can NEVER extend.
 * 2. Idle timeout: inactivity window that extends on activity within the absolute lifetime.
 *
 * Guarantees:
 * - All date arithmetic is performed in UTC.
 * - Clock skew leeway is respected.
 * - Store writes on activity updates are throttled to prevent write storms.
 * - Expired or missing-expiry sessions/tokens return 401 UNAUTHORIZED.
 * - Native store TTL + periodic unref'd cleanup timer.
 * - Server-side invalidation on logout.
 * - Legacy sessions without explicit expiry fields are supported by deriving from created_at.
 * - Cookie options helper strictly mirrors remaining server-side session lifetime.
 */

const crypto = require('crypto');
const cache = require('../services/cache');
const logger = require('../logger');
const AppError = require('../errors/AppError');

function getEnvNumber(key, defaultValue) {
  const val = process.env[key];
  if (val !== undefined && val !== '') {
    const num = Number(val);
    if (Number.isSafeInteger(num) && num > 0) return num;
  }
  return defaultValue;
}

// Configuration with documented defaults
const ABSOLUTE_LIFETIME_SECONDS = getEnvNumber('SESSION_ABSOLUTE_LIFETIME_SECONDS', 24 * 60 * 60); // 24 hours
const IDLE_TIMEOUT_SECONDS = getEnvNumber('SESSION_IDLE_TIMEOUT_SECONDS', 30 * 60); // 30 minutes
const ACTIVITY_THROTTLE_SECONDS = getEnvNumber('SESSION_ACTIVITY_THROTTLE_SECONDS', 60); // 1 minute
const CLOCK_SKEW_SECONDS = getEnvNumber('SESSION_CLOCK_SKEW_SECONDS', 60); // 60 seconds

const SESSIONS_ACTIVE_INDEX = 'sessions:active';
let cleanupTimer = null;

function sessionKey(id) {
  return `session:${id}`;
}

function generateSessionId() {
  return `sess_${crypto.randomUUID().replace(/-/g, '')}`;
}

function sanitizeSession(record) {
  if (!record) return null;
  return { ...record };
}

/**
 * Derives expiry boundaries in UTC milliseconds.
 * If record lacks absolute_expires_at or idle_expires_at (legacy session),
 * derives them safely from created_at without requiring a database migration.
 */
function getSessionTimestamps(record) {
  const createdAtMs = Date.parse(record.created_at) || Date.now();
  const lastActivityMs = Date.parse(record.last_activity_at || record.last_validated_at) || createdAtMs;

  const absoluteExpiresAtMs = record.absolute_expires_at
    ? Date.parse(record.absolute_expires_at)
    : createdAtMs + ABSOLUTE_LIFETIME_SECONDS * 1000;

  const idleExpiresAtMs = record.idle_expires_at
    ? Date.parse(record.idle_expires_at)
    : lastActivityMs + IDLE_TIMEOUT_SECONDS * 1000;

  return {
    createdAtMs,
    lastActivityMs,
    absoluteExpiresAtMs,
    idleExpiresAtMs,
  };
}

/**
 * Check if a session record has expired against either absolute or idle window.
 */
function isSessionExpired(record, nowMs = Date.now()) {
  if (!record || record.active === false) return true;

  const { absoluteExpiresAtMs, idleExpiresAtMs } = getSessionTimestamps(record);
  const leewayMs = CLOCK_SKEW_SECONDS * 1000;

  // 1. Check absolute lifetime: activity can NEVER extend this window
  if (nowMs > absoluteExpiresAtMs + leewayMs) {
    return true;
  }

  // 2. Check idle timeout: exceeded inactivity window
  if (nowMs > idleExpiresAtMs + leewayMs) {
    return true;
  }

  return false;
}

/**
 * Create a new server-side session.
 */
async function createSession(userId, metadata = {}) {
  if (!userId) {
    throw new Error('createSession: userId is required');
  }

  const now = new Date();
  const nowMs = now.getTime();
  const absoluteExpiresAtMs = nowMs + ABSOLUTE_LIFETIME_SECONDS * 1000;
  const idleExpiresAtMs = nowMs + IDLE_TIMEOUT_SECONDS * 1000;
  const effectiveExpiryMs = Math.min(absoluteExpiresAtMs, idleExpiresAtMs);

  const record = {
    id: generateSessionId(),
    user_id: userId,
    active: true,
    created_at: now.toISOString(),
    last_activity_at: now.toISOString(),
    absolute_expires_at: new Date(absoluteExpiresAtMs).toISOString(),
    idle_expires_at: new Date(idleExpiresAtMs).toISOString(),
    ip_address: metadata.ipAddress || null,
    user_agent: metadata.userAgent || null,
  };

  const ttlSeconds = Math.max(1, Math.ceil((absoluteExpiresAtMs - nowMs) / 1000));
  await cache.set(sessionKey(record.id), record, ttlSeconds);

  try {
    const redis = cache.getClient();
    if (redis && typeof redis.zadd === 'function') {
      await redis.zadd(SESSIONS_ACTIVE_INDEX, effectiveExpiryMs, record.id);
    }
  } catch (err) {
    logger.warn('Failed to add session to active index', { error: err.message });
  }

  return sanitizeSession(record);
}

/**
 * Validate session and update last-activity with throttling.
 *
 * If session is expired or invalid: returns null.
 * If activity write is throttled: returns session without Redis write.
 * If throttle window has elapsed: updates last_activity_at and extends idle timeout
 * (up to the fixed absolute lifetime).
 */
async function validateSession(sessionId, { touch = true, now = new Date() } = {}) {
  if (!sessionId) return null;

  const record = await cache.get(sessionKey(sessionId));
  if (!record) return null;

  const nowMs = now.getTime();
  if (isSessionExpired(record, nowMs)) {
    // Lazily clean up expired session
    await invalidateSession(sessionId);
    return null;
  }

  if (!touch) {
    return sanitizeSession(record);
  }

  const { lastActivityMs, absoluteExpiresAtMs } = getSessionTimestamps(record);
  const throttleMs = ACTIVITY_THROTTLE_SECONDS * 1000;

  // Throttling: If last write was within throttle window, DO NOT write to store
  if (nowMs - lastActivityMs < throttleMs) {
    return sanitizeSession(record);
  }

  // Extend idle expiry, but NEVER exceed the absolute lifetime
  const newIdleExpiresAtMs = Math.min(nowMs + IDLE_TIMEOUT_SECONDS * 1000, absoluteExpiresAtMs);
  const remainingTtlSeconds = Math.max(1, Math.ceil((newIdleExpiresAtMs - nowMs) / 1000));

  const updatedRecord = {
    ...record,
    last_activity_at: now.toISOString(),
    idle_expires_at: new Date(newIdleExpiresAtMs).toISOString(),
    // Preserve or derive absolute_expires_at for legacy sessions
    absolute_expires_at: record.absolute_expires_at || new Date(absoluteExpiresAtMs).toISOString(),
  };

  await cache.set(sessionKey(sessionId), updatedRecord, remainingTtlSeconds);

  try {
    const redis = cache.getClient();
    if (redis && typeof redis.zadd === 'function') {
      await redis.zadd(SESSIONS_ACTIVE_INDEX, newIdleExpiresAtMs, sessionId);
    }
  } catch (err) {
    logger.warn('Failed to update session active index score', { error: err.message });
  }

  return sanitizeSession(updatedRecord);
}

/**
 * Invalidate a session server-side (logout / revocation).
 */
async function invalidateSession(sessionId) {
  if (!sessionId) return false;

  try {
    await cache.del(sessionKey(sessionId));
    const redis = cache.getClient();
    if (redis && typeof redis.zrem === 'function') {
      await redis.zrem(SESSIONS_ACTIVE_INDEX, sessionId);
    }
    return true;
  } catch (err) {
    logger.error('Failed to invalidate session', { sessionId, error: err.message });
    return false;
  }
}

/**
 * Scheduled cleanup of expired sessions from active index.
 */
async function cleanupExpiredSessions({ limit = 500, nowMs = Date.now() } = {}) {
  try {
    const redis = cache.getClient();
    if (!redis || typeof redis.zrangebyscore !== 'function') {
      return { cleaned: 0, checked: 0 };
    }

    const expiredIds = await redis.zrangebyscore(
      SESSIONS_ACTIVE_INDEX,
      0,
      nowMs,
      'LIMIT',
      0,
      limit
    );

    if (!expiredIds || expiredIds.length === 0) {
      return { cleaned: 0, checked: 0 };
    }

    const pipeline = redis.multi ? redis.multi() : null;
    if (pipeline) {
      expiredIds.forEach((id) => pipeline.zrem(SESSIONS_ACTIVE_INDEX, id));
      await pipeline.exec();
    } else {
      await Promise.all(expiredIds.map((id) => redis.zrem(SESSIONS_ACTIVE_INDEX, id)));
    }

    await Promise.all(expiredIds.map((id) => cache.del(sessionKey(id))));
    return { cleaned: expiredIds.length, checked: expiredIds.length };
  } catch (err) {
    logger.error('cleanupExpiredSessions error', { error: err.message });
    return { cleaned: 0, checked: 0 };
  }
}

/**
 * Start background periodic cleanup with an unref'd timer (no listener leaks, no hanging process).
 */
function startCleanupTimer(intervalMs = 15 * 60 * 1000) {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    cleanupExpiredSessions().catch((err) => {
      logger.warn('Periodic session cleanup encountered error', { error: err.message });
    });
  }, intervalMs);

  if (typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref();
  }
}

function stopCleanupTimer() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/**
 * Helper to compute secure cookie options aligned with server-side session expiry (#496).
 */
function getSessionCookieOptions(session, options = {}) {
  const isSecure = options.isSecure !== undefined
    ? options.isSecure
    : process.env.NODE_ENV === 'production';

  const nowMs = Date.now();
  let maxAgeMs = IDLE_TIMEOUT_SECONDS * 1000;

  if (session) {
    const { absoluteExpiresAtMs, idleExpiresAtMs } = getSessionTimestamps(session);
    const effectiveExpiryMs = Math.min(absoluteExpiresAtMs, idleExpiresAtMs);
    maxAgeMs = Math.max(0, effectiveExpiryMs - nowMs);
  }

  return {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs,
  };
}

/**
 * Express middleware for authenticating requests via session.
 */
function sessionAuth(options = {}) {
  const { required = true } = options;

  return async (req, res, next) => {
    const rawCookie = req.headers.cookie || '';
    let sessionId = null;

    // Extract session from cookie: session_id=...
    const cookieMatch = rawCookie.match(/(?:^|;\s*)session_id=([^;]+)/);
    if (cookieMatch) {
      sessionId = decodeURIComponent(cookieMatch[1]);
    } else if (req.get('x-session-id')) {
      sessionId = req.get('x-session-id');
    }

    if (!sessionId) {
      if (required) {
        return next(new AppError('UNAUTHORIZED', 'Invalid credentials', 401));
      }
      return next();
    }

    try {
      // Validate session; pass touch: false so a request that subsequently fails
      // will NOT have extended session activity
      const session = await validateSession(sessionId, { touch: false });
      if (!session) {
        return next(new AppError('UNAUTHORIZED', 'Invalid credentials', 401));
      }

      req.session = session;
      req.user = { id: session.user_id };

      // Touch session only when response finishes successfully without auth failure
      res.on('finish', () => {
        if (res.statusCode < 400) {
          validateSession(sessionId, { touch: true }).catch((err) => {
            logger.warn('Failed to touch session on request finish', {
              sessionId,
              error: err.message,
            });
          });
        }
      });

      return next();
    } catch (err) {
      logger.error('Session authentication error', { error: err.message });
      return next(new AppError('UNAUTHORIZED', 'Invalid credentials', 401));
    }
  };
}

module.exports = {
  createSession,
  validateSession,
  invalidateSession,
  cleanupExpiredSessions,
  startCleanupTimer,
  stopCleanupTimer,
  getSessionCookieOptions,
  sessionAuth,
  isSessionExpired,
  getSessionTimestamps,
  ABSOLUTE_LIFETIME_SECONDS,
  IDLE_TIMEOUT_SECONDS,
  ACTIVITY_THROTTLE_SECONDS,
  CLOCK_SKEW_SECONDS,
};
