'use strict';

/**
 * API key usage analytics (#669).
 *
 * Summarises the per-key request records that `auditApiKeyUsage` already
 * writes to `api_key_audit_logs` (endpoint, IP, status code, response time,
 * timestamp). No new table or write path is added here.
 */

const apiKeyAuditLog = require('../services/apiKeyAuditLog');

const DEFAULT_SAMPLE_SIZE = 1000;
const MAX_SAMPLE_SIZE = 5000;

/**
 * Pure aggregation over audit log rows. Rows may be in any order.
 *
 * @param {Array<{endpoint?: string, ip_address?: string, status_code?: number|null,
 *   response_time_ms?: number|null, created_at?: string|Date}>} rows
 */
function summarizeKeyUsage(rows) {
  const byEndpoint = {};
  const byStatus = {};
  const ips = new Set();
  let errorCount = 0;
  let totalMs = 0;
  let timedCount = 0;
  let lastSeen = null;

  for (const row of rows) {
    if (row.endpoint) {
      byEndpoint[row.endpoint] = (byEndpoint[row.endpoint] || 0) + 1;
    }
    if (row.status_code != null) {
      byStatus[row.status_code] = (byStatus[row.status_code] || 0) + 1;
      if (row.status_code >= 400) errorCount += 1;
    }
    if (row.ip_address) ips.add(row.ip_address);
    if (typeof row.response_time_ms === 'number') {
      totalMs += row.response_time_ms;
      timedCount += 1;
    }
    const ts = row.created_at ? new Date(row.created_at) : null;
    if (ts && !Number.isNaN(ts.getTime()) && (!lastSeen || ts > lastSeen)) {
      lastSeen = ts;
    }
  }

  const totalRequests = rows.length;
  return {
    totalRequests,
    errorCount,
    errorRate: totalRequests ? Math.round((errorCount / totalRequests) * 10000) / 10000 : 0,
    avgResponseMs: timedCount ? Math.round((totalMs / timedCount) * 100) / 100 : 0,
    distinctIps: ips.size,
    byEndpoint,
    byStatus,
    lastSeen: lastSeen ? lastSeen.toISOString() : null,
  };
}

/**
 * Usage summary for one key, based on its most recent audit rows.
 * `sampleSize` reports how many rows were aggregated, so callers can tell
 * when the summary covers only the latest slice of history.
 *
 * @param {string} keyId
 * @param {{limit?: number}} [options]
 */
async function getKeyUsageSummary(keyId, { limit = DEFAULT_SAMPLE_SIZE } = {}) {
  const parsed = Math.floor(Number(limit));
  const sampleLimit = Math.min(Math.max(parsed > 0 ? parsed : DEFAULT_SAMPLE_SIZE, 1), MAX_SAMPLE_SIZE);
  const rows = await apiKeyAuditLog.getKeyAuditLog(keyId, sampleLimit, 0);
  return { sampleSize: rows.length, ...summarizeKeyUsage(rows) };
}

module.exports = { summarizeKeyUsage, getKeyUsageSummary };
