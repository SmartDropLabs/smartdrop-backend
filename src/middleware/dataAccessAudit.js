'use strict';

const logger = require('../logger');

/**
 * Data access audit trail (issue #563, #660).
 *
 * Logs every data read/write operation for accountability, breach
 * detection, and compliance. Unlike the admin-action AuditLogger (#473)
 * and the API-key usage log (#551), this records *what data* was accessed
 * by *whom*, regardless of auth method.
 * 
 * Issue #660: Database indexes required for efficient audit queries:
 * 
 * CREATE INDEX idx_audit_user ON audit_log(user_id);
 * CREATE INDEX idx_audit_timestamp ON audit_log(timestamp);
 * CREATE INDEX idx_audit_resource ON audit_log(resource, resource_id);
 * CREATE INDEX idx_audit_action ON audit_log(action, timestamp DESC);
 * 
 * These indexes prevent slow audit queries and performance degradation
 * when the audit log grows. Apply via migration script.
 */

const DEFAULT_SENSITIVE_FIELDS = [
  'email',
  'phone',
  'ssn',
  'password',
  'token',
  'secret',
  'apiKey',
  'creditCard',
];

function maskSensitive(data, sensitiveFields = DEFAULT_SENSITIVE_FIELDS) {
  if (data === null || data === undefined || typeof data !== 'object') {
    return data;
  }
  if (Array.isArray(data)) {
    return data.map((item) => maskSensitive(item, sensitiveFields));
  }
  const sensitiveSet = new Set(sensitiveFields.map((f) => String(f).toLowerCase()));
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (sensitiveSet.has(key.toLowerCase())) {
      out[key] = '[REDACTED]';
    } else if (value && typeof value === 'object') {
      out[key] = maskSensitive(value, sensitiveFields);
    } else {
      out[key] = value;
    }
  }
  return out;
}

class DataAccessAuditor {
  /**
   * Record a data access event.
   * @param {object} params
   * @param {string} params.actor - User ID, API key ID, or 'system'
   * @param {string} params.action - 'read' | 'write' | 'delete' | 'export'
   * @param {string} params.resource - Resource type (e.g. 'airdrop', 'webhook')
   * @param {string} [params.resourceId] - Specific resource identifier
   * @param {string} [params.endpoint] - HTTP endpoint accessed
   * @param {string} [params.ip] - Client IP address
   * @param {object} [params.details] - Additional context (filters, field list, etc.)
   * @param {string} [params.result] - 'success' | 'failure' | 'denied'
   */
  static log({ actor, action, resource, resourceId, endpoint, ip, details, result = 'success' }) {
    logger.info('[DATA_ACCESS]', {
      type: 'data_access',
      actor: actor || 'unknown',
      action,
      resource,
      resource_id: resourceId || null,
      endpoint: endpoint || null,
      ip: ip || null,
      result,
      timestamp: new Date().toISOString(),
      ...(details && { details: maskSensitive(details) }),
    });
  }

  /**
   * Express middleware that logs data-access events for matching routes.
   * @param {string} action - The data action to log
   * @param {Function} [getResource] - Extracts resource name from req
   */
  static middleware(action, getResource) {
    return (req, res, next) => {
      const actor =
        req.user?.id || req.apiKeyId || req.headers['x-api-key']?.slice(0, 8) || 'anonymous';
      const resource = getResource ? getResource(req) : req.path;

      const originalJson = res.json.bind(res);
      res.json = (body) => {
        DataAccessAuditor.log({
          actor,
          action,
          resource,
          resourceId: req.params?.id,
          endpoint: `${req.method} ${req.originalUrl}`,
          ip: req.ip,
          result: res.statusCode < 400 ? 'success' : 'failure',
          details: { statusCode: res.statusCode },
        });
        return originalJson(body);
      };

      next();
    };
  }
}

module.exports = { DataAccessAuditor, maskSensitive, DEFAULT_SENSITIVE_FIELDS };
