const knex = require('knex');
const config = require('../config');
const logger = require('../logger');

let db = null;

function getDb() {
  if (!db) {
    db = knex({
      client: 'pg',
      connection: config.databaseUrl,
      pool: { min: 2, max: 10 },
    });
  }
  return db;
}

/**
 * Log API key usage to audit trail
 * 
 * @param {object} options
 * @param {string} options.keyId - The API key ID
 * @param {string} options.endpoint - The endpoint accessed (e.g., "GET /api/prices")
 * @param {string} options.ipAddress - Client IP address
 * @param {number} options.statusCode - HTTP response status code
 * @param {number} options.responseTimeMs - Request duration in milliseconds
 */
async function logUsage({ keyId, endpoint, ipAddress, statusCode, responseTimeMs }) {
  try {
    if (!keyId || keyId === 'admin') {
      // Skip logging for admin key or missing key
      return;
    }

    await getDb()('api_key_audit_logs').insert({
      key_id: keyId,
      endpoint,
      ip_address: ipAddress,
      status_code: statusCode,
      response_time_ms: responseTimeMs,
      created_at: new Date(),
    });
  } catch (err) {
    // Log the error but don't fail the request
    logger.error('Failed to log API key audit trail', {
      keyId,
      endpoint,
      error: err.message,
    });
  }
}

/**
 * Get audit log entries for a specific API key
 * 
 * @param {string} keyId - The API key ID
 * @param {number} limit - Maximum number of entries to return
 * @param {number} offset - Number of entries to skip
 * @returns {Promise<Array>} Audit log entries
 */
async function getKeyAuditLog(keyId, limit = 100, offset = 0) {
  try {
    return await getDb()('api_key_audit_logs')
      .where('key_id', keyId)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset);
  } catch (err) {
    logger.error('Failed to fetch API key audit log', {
      keyId,
      error: err.message,
    });
    return [];
  }
}

/**
 * Get recent audit log entries for all keys (admin only)
 * 
 * @param {number} limit - Maximum number of entries to return
 * @param {number} offset - Number of entries to skip
 * @returns {Promise<Array>} Audit log entries
 */
async function getAllAuditLogs(limit = 100, offset = 0) {
  try {
    return await getDb()('api_key_audit_logs')
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset);
  } catch (err) {
    logger.error('Failed to fetch all API key audit logs', { error: err.message });
    return [];
  }
}

module.exports = {
  logUsage,
  getKeyAuditLog,
  getAllAuditLogs,
};
