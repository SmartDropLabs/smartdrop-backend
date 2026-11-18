'use strict';

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const logger = require('../logger');

/**
 * Rotation settings for the dedicated audit log file (#620). Audit records
 * are kept apart from the application log so they can have their own
 * (longer, compliance-driven) retention, and are rotated daily and by size
 * so they can never fill the disk. Returns null when no directory is
 * configured, in which case audit records only go to the main logger.
 *
 * Env: AUDIT_LOG_DIR (falls back to LOG_FILE_PATH), AUDIT_LOG_MAX_SIZE
 * (default 20m), AUDIT_LOG_RETENTION (default 90d).
 */
function auditRotationOptions(env = process.env) {
  const dir = env.AUDIT_LOG_DIR || env.LOG_FILE_PATH;
  if (!dir) return null;
  return {
    filename: `${dir}/audit-%DATE%.log`,
    datePattern: 'YYYY-MM-DD',
    utc: true,
    zippedArchive: true,
    maxSize: env.AUDIT_LOG_MAX_SIZE || '20m',
    maxFiles: env.AUDIT_LOG_RETENTION || '90d',
  };
}

let auditFileLogger;

function getAuditFileLogger() {
  if (auditFileLogger === undefined) {
    const options = auditRotationOptions();
    auditFileLogger = options
      ? winston.createLogger({
        level: 'info',
        format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
        transports: [new DailyRotateFile(options)],
      })
      : null;
  }
  return auditFileLogger;
}

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
    const entry = {
      type: 'admin_action',
      admin,
      action,
      resource,
      result,
      timestamp: new Date().toISOString(),
      ...(details && { details }),
    };
    logger.info('[AUDIT]', entry);
    const fileLogger = getAuditFileLogger();
    if (fileLogger) fileLogger.info('[AUDIT]', entry);
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

module.exports = { AuditLogger, auditRotationOptions };
