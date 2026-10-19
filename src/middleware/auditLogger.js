'use strict';

const logger = require('../logger');

/**
 * AuditLogger (#473)
 *
 * Logs all admin actions for accountability and compliance.
 * Every admin action is logged with the admin identity, action type,
 * target resource, and result.
 */
class AuditLogger {
  /**
   * Log an admin action.
   * @param {object} params
   * @param {string} params.admin - Admin identity (user ID or IP)
   * @param {string} params.action - Action performed (e.g. 'delete_webhook')
   * @param {string} params.resource - Target resource (e.g. 'webhook:abc-123')
   * @param {object} [params.details] - Additional context
   * @param {string} [params.result] - 'success' or 'failure'
   */
  static log({ admin, action, resource, details, result = 'success' }) {
    logger.info('[AUDIT]', {
      type: 'admin_action',
      admin,
      action,
      resource,
      result,
      timestamp: new Date().toISOString(),
      ...(details && { details }),
    });
  }

  /** Wrap an Express handler to log admin actions automatically. */
  static middleware(action, getResource) {
    return (req, res, next) => {
      const admin = req.user?.id || req.headers['x-admin-id'] || req.ip || 'unknown';
      const resource = getResource ? getResource(req) : req.path;

      const originalJson = res.json.bind(res);
      res.json = (body) => {
        AuditLogger.log({
          admin,
          action,
          resource,
          result: res.statusCode < 400 ? 'success' : 'failure',
          details: { statusCode: res.statusCode },
        });
        return originalJson(body);
      };

      next();
    };
  }
}

module.exports = { AuditLogger };
