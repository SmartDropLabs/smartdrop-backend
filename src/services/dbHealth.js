'use strict';

/**
 * Database health probe (issue #376).
 *
 * `/health` used to report `status: 'unused'` after checking only that a
 * connection string was configured — a value that reads as "the database is
 * fine" while saying nothing about whether it can be reached. The endpoint now
 * runs a real probe (`SELECT 1` over a short-lived connection) and reports what
 * happened:
 *
 *   - `unavailable` — no connection string configured, nothing to probe.
 *   - `ok`          — the probe connected and answered; `latency_ms` says how
 *                     long that took.
 *   - `error`       — the probe failed or exceeded its timeout; `error` carries
 *                     the reason.
 *
 * The probe is bounded by `timeoutMs` so a hung database cannot hang `/health`
 * itself: whatever the database does, the endpoint still answers, and answering
 * slowly is exactly the failure this check exists to expose.
 *
 * `checkDatabase` takes an injected `ping` so the probe's own behaviour can be
 * tested without a database; `defaultPing` is the real implementation.
 */

const { Client } = require('pg');

const config = require('../config');

const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Rejects after `ms`, so a probe that never settles is reported as an error
 * instead of holding the request open. The timer is always cleared.
 */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`database ping timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Opens a connection, runs `SELECT 1`, closes it. A fresh connection per probe
 * is deliberate: it proves the database is reachable *now*, which an idle
 * pooled connection does not.
 */
async function defaultPing(timeoutMs = DEFAULT_TIMEOUT_MS) {
  const client = new Client({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: timeoutMs,
  });

  try {
    await client.connect();
    await client.query('SELECT 1');
  } finally {
    // A failed connect still has a socket to release; a failure here must not
    // mask the error that caused it.
    await client.end().catch(() => {});
  }
}

async function checkDatabase(options = {}) {
  const { ping = defaultPing, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  if (!config.databaseUrl) {
    return { configured: false, checked: false, status: 'unavailable' };
  }

  const startedAt = Date.now();

  try {
    await withTimeout(ping(timeoutMs), timeoutMs);
    return {
      configured: true,
      checked: true,
      status: 'ok',
      latency_ms: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      configured: true,
      checked: true,
      status: 'error',
      latency_ms: Date.now() - startedAt,
      error: err && err.message ? err.message : String(err),
    };
  }
}

module.exports = { checkDatabase, DEFAULT_TIMEOUT_MS };
