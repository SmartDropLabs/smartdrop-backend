const { getDb } = require('../database');
const logger = require('../logger');
const { nowIso } = require('../utils/dates');

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
async function logUsage({ keyId, endpoint, ipAddress, statusCode, responseTimeMs }, trx) {
  try {
    if (!keyId || keyId === 'admin') {
      // Skip logging for admin key or missing key
      return;
    }

    const client = trx || getDb();
    await client('api_key_audit_logs').insert({
      key_id: keyId,
      endpoint,
      ip_address: ipAddress,
      status_code: statusCode,
      response_time_ms: responseTimeMs,
      // Issue #494 — serialize the instant in UTC explicitly. A bare Date
      // relies on the driver/host time zone for its text form; the shared
      // helper always emits ISO-8601 with a Z suffix.
      created_at: nowIso(),
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
 * @param {import('knex').Knex.Transaction} [trx] - Optional transaction client
 * @returns {Promise<Array>} Audit log entries
 */
async function getKeyAuditLog(keyId, limit = 100, offset = 0, trx) {
  try {
    const client = trx || getDb();
    return await client('api_key_audit_logs')
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
 * @param {import('knex').Knex.Transaction} [trx] - Optional transaction client
 * @returns {Promise<Array>} Audit log entries
 */
async function getAllAuditLogs(limit = 100, offset = 0, trx) {
  try {
    const client = trx || getDb();
    return await client('api_key_audit_logs')
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
