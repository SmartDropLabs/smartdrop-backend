'use strict';

const { buildRateLimit } = require('../middleware/rateLimit');
const cache = require('../services/cache');
const AppError = require('../errors/AppError');

// 5 password reset attempts per 15 minutes per IP (#558).
// Prevents email bombing and user enumeration via timing.
const passwordResetRateLimit = buildRateLimit({
  windowSeconds: 900,
  max: 5,
  keyPrefix: 'pwd_reset',
});

// Per-user password reset rate limit (#648)
// In-memory fallback when redis is unavailable
const userResetCounts = new Map();

async function checkUserPasswordResetRateLimit(userId, maxAttempts = 3, windowSeconds = 3600) {
  if (!userId) return;

  const key = `reset:${userId}`;
  try {
    if (typeof cache.isConnected === 'function' && cache.isConnected()) {
      const client = cache.getClient();
      if (client && typeof client.incr === 'function') {
        const count = await client.incr(key);
        if (count === 1 && typeof client.expire === 'function') {
          await client.expire(key, windowSeconds);
        }
        if (count > maxAttempts) {
          throw new AppError('RATE_LIMIT', 'Too many requests', 429);
        }
        return count;
      }
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
  }

  // In-memory fallback
  const now = Date.now();
  const record = userResetCounts.get(userId);
  if (!record || now > record.resetAt) {
    userResetCounts.set(userId, { count: 1, resetAt: now + windowSeconds * 1000 });
    return 1;
  }

  record.count += 1;
  if (record.count > maxAttempts) {
    throw new AppError('RATE_LIMIT', 'Too many requests', 429);
  }
  return record.count;
}

/**
 * Express middleware for per-user password reset rate limiting (#648).
 */
function userPasswordResetRateLimit(options = {}) {
  const maxAttempts = options.max || 3;
  const windowSeconds = options.windowSeconds || 3600;

  return async (req, res, next) => {
    try {
      const userId = req.body?.userId || req.body?.email || req.params?.userId;
      if (userId) {
        await checkUserPasswordResetRateLimit(userId, maxAttempts, windowSeconds);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = {
  passwordResetRateLimit,
  checkUserPasswordResetRateLimit,
  userPasswordResetRateLimit,
};
