const { getDb } = require('../database');
const logger = require('../logger');
const { nowIso } = require('../utils/dates');

// IP geolocation is opt-in: nothing is looked up until a provider is set with
// setGeoLookup(). The lookup has a short timeout and never blocks or fails the
// audit write.
const GEO_LOOKUP_TIMEOUT_MS = 500;
let geoLookup = null;

/**
 * Set the IP geolocation provider (#697). The function receives an IP address
 * and resolves to `{ country }` with an ISO 3166-1 alpha-2 code, or null.
 * Pass null to disable lookups.
 * @param {((ip: string) => Promise<{country?: string} | null>) | null} fn
 */
function setGeoLookup(fn) {
  if (fn !== null && typeof fn !== 'function') {
    throw new Error('setGeoLookup expects a function or null');
  }
  geoLookup = fn;
}

/**
 * Resolve the country for an IP. Returns null when no provider is set, the
 * lookup fails, or it takes longer than GEO_LOOKUP_TIMEOUT_MS.
 * @param {string} ipAddress
 * @returns {Promise<string|null>}
 */
async function resolveCountry(ipAddress) {
  if (!geoLookup || !ipAddress) return null;
  let timer;
  try {
    const geo = await Promise.race([
      geoLookup(ipAddress),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), GEO_LOOKUP_TIMEOUT_MS);
        if (timer.unref) timer.unref();
      }),
    ]);
    const code = geo && typeof geo.country === 'string' ? geo.country.trim() : '';
    return /^[A-Za-z]{2}$/.test(code) ? code.toUpperCase() : null;
  } catch (err) {
    logger.warn('IP geolocation lookup failed', { error: err.message });
    return null;
  } finally {
    clearTimeout(timer);
  }
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
async function logUsage({ keyId, endpoint, ipAddress, statusCode, responseTimeMs }, trx) {
  try {
    if (!keyId || keyId === 'admin') {
      // Skip logging for admin key or missing key
      return;
    }

    const country = await resolveCountry(ipAddress);
    const client = trx || getDb();
    await client('api_key_audit_logs').insert({
      country,
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

const DEFAULT_RETENTION_DAYS = 90;

/**
 * Prune audit logs older than the retention threshold (#641).
 * @param {number} [retentionDays=90]
 * @param {import('knex').Knex.Transaction} [trx]
 * @returns {Promise<number>} Number of deleted rows
 */
async function pruneAuditLogs(retentionDays = DEFAULT_RETENTION_DAYS, trx) {
  if (typeof retentionDays !== 'number' || retentionDays <= 0 || !Number.isFinite(retentionDays)) {
    throw new Error('retentionDays must be greater than 0');
  }
  try {
    const client = trx || getDb();
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    const deletedCount = await client('api_key_audit_logs')
      .where('created_at', '<', cutoff)
      .del();
    logger.info(`Pruned ${deletedCount} API key audit log entries older than ${retentionDays} days`);
    return deletedCount;
  } catch (err) {
    logger.error('Failed to prune API key audit logs', { error: err.message });
    return 0;
  }
}

module.exports = {
  logUsage,
  setGeoLookup,
  resolveCountry,
  getKeyAuditLog,
  getAllAuditLogs,
  pruneAuditLogs,
  DEFAULT_RETENTION_DAYS,
};
