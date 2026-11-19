'use strict';

/**
 * Resource-level permission middleware (#489).
 *
 * Verifies the authenticated user has permission to access a specific
 * resource before the handler runs. Prevents unauthorized access and
 * data leakage across users.
 */

const cache = require('../services/cache');
const logger = require('../logger');

/**
 * Get cached user permissions or load via fetcher (#650).
 * @param {string} userId
 * @param {Function} fetcher - Async () => Array<string>
 * @param {number} [ttlSeconds=300]
 * @returns {Promise<Array<string>>}
 */
async function getUserPermissions(userId, fetcher, ttlSeconds = 300) {
  if (!userId) return [];
  const cacheKey = `perms:${userId}`;
  try {
    const cached = await cache.get(cacheKey);
    if (cached) return Array.isArray(cached) ? cached : JSON.parse(cached);
  } catch {
    // Cache read failed, fall through to fetcher
  }

  const perms = fetcher ? await fetcher(userId) : [];
  try {
    await cache.set(cacheKey, perms, ttlSeconds);
  } catch {
    // Ignore cache write error
  }
  return perms;
}

/**
 * Invalidate cached user permissions (#650).
 * @param {string} userId
 */
async function invalidateUserPermissions(userId) {
  if (!userId) return;
  try {
    await cache.del(`perms:${userId}`);
  } catch {
    // Ignore cache error
  }
}

/**
 * Create a middleware that checks resource ownership/permission.
 *
 * @param {Object} options
 * @param {Function} options.getResourceOwner - Async (req) => owner userId string
 * @param {Function} [options.isAllowed] - Custom permission check (req, owner) => boolean
 * @param {string} [options.resourceName] - Name for error messages
 * @returns {Function} Express middleware
 */
function requireResourcePermission(options) {
  const { getResourceOwner, isAllowed, resourceName = 'resource' } = options;

  return async (req, res, next) => {
    try {
      const userId = req.user?.id || req.user?.userId;
      if (!userId) {
        return res.status(401).json({
          statusCode: 401,
          message: 'Authentication required',
        });
      }

      const ownerId = await getResourceOwner(req);
      if (!ownerId) {
        return res.status(404).json({
          statusCode: 404,
          message: `${resourceName} not found`,
        });
      }

      const allowed = isAllowed
        ? await isAllowed(req, ownerId)
        : ownerId === userId;

      if (!allowed) {
        logger.warn(
          `Permission denied: user ${userId} tried to access ${resourceName} owned by ${ownerId}`,
        );
        return res.status(403).json({
          statusCode: 403,
          message: `You do not have permission to access this ${resourceName}`,
        });
      }

      next();
    } catch (err) {
      logger.error(`Permission check failed for ${resourceName}: ${err}`);
      return res.status(500).json({
        statusCode: 500,
        message: 'Permission check failed',
      });
    }
  };
}

/**
 * Simple role-based permission check middleware.
 *
 * @param  {...string} roles - Allowed roles
 * @returns {Function} Express middleware
 */
function requireRole(...roles) {
  return (req, res, next) => {
    const userRole = req.user?.role;
    if (!userRole || !roles.includes(userRole)) {
      logger.warn(
        `Role denied: user ${req.user?.id} with role ${userRole} tried to access route requiring ${roles.join(', ')}`,
      );
      return res.status(403).json({
        statusCode: 403,
        message: 'Insufficient permissions',
      });
    }
    next();
  };
}

module.exports = {
  requireResourcePermission,
  requireRole,
  getUserPermissions,
  invalidateUserPermissions,
};
