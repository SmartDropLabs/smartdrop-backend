'use strict';

/**
 * Lightweight database health check. Uses the `pg` driver directly if
 * available; gracefully reports unconfigured when the driver or
 * DATABASE_URL is absent.
 *
 * The check runs a `SELECT 1` ping with a 3-second timeout so a
 * hung connection cannot block the /health response indefinitely.
 */

let Pool;
try {
  ({ Pool } = require('pg'));
} catch {
  // pg not installed — database is not part of this deployment's stack.
}

let pool = null;

function getPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!Pool || !url) return null;
  pool = new Pool({ connectionString: url, connectionTimeoutMillis: 3000 });
  return pool;
}

async function checkDatabase() {
  const p = getPool();
  if (!p) {
    return { configured: false, checked: false, status: 'unavailable' };
  }

  try {
    const client = await p.connect();
    try {
      await client.query('SELECT 1');
      return { configured: true, checked: true, status: 'ok' };
    } finally {
      client.release();
    }
  } catch (err) {
    return { configured: true, checked: true, status: 'error', error: err.message };
  }
}

module.exports = { checkDatabase };
