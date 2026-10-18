'use strict';

const knexFactory = require('knex');
const config = require('../config');
const { withTransaction } = require('./transaction');
const logger = require('../logger');

let db = null;

/**
 * Get or initialize the shared Knex database singleton.
 *
 * @param {Object} [overrideConfig] - Optional configuration overrides (useful for testing)
 * @returns {import('knex').Knex}
 */
function getDb(overrideConfig = {}) {
  if (!db) {
    db = knexFactory({
      client: 'pg',
      connection: overrideConfig.connection || config.databaseUrl,
      pool: overrideConfig.pool || { min: 2, max: 10 },
      ...overrideConfig,
    });
  }
  return db;
}

/**
 * Set the shared Knex instance (primarily for tests).
 *
 * @param {import('knex').Knex|null} instance
 */
function setDb(instance) {
  db = instance;
}

/**
 * Close and destroy the database connection pool.
 */
async function closeDb() {
  if (db) {
    await db.destroy();
    db = null;
  }
}

/**
 * Execute a callback with a dedicated database connection, guaranteeing
 * release back to the pool even on error (#488).
 *
 * Use this for raw queries or multi-statement operations that need a
 * pinned connection. For single queries, Knex's query builder auto-releases.
 *
 * @param {Function} callback - Async function receiving (conn) to execute queries
 * @returns {Promise<*>} The result of the callback
 */
async function withConnection(callback) {
  const currentDb = getDb();
  const conn = await currentDb.client.acquireConnection();
  try {
    return await callback(conn);
  } finally {
    currentDb.client.releaseConnection(conn);
  }
}

/**
 * Get current pool statistics for monitoring connection usage (#488).
 *
 * @returns {Object} Pool stats
 */
function getPoolStats() {
  const currentDb = getDb();
  const pool = currentDb.client.pool;
  return {
    min: pool.min,
    max: pool.max,
    used: pool.numUsed(),
    free: pool.numFree(),
    pendingAcquires: pool.numPendingAcquires(),
    pendingCreates: pool.numPendingCreates(),
  };
}

/**
 * Convenience wrapper for `withTransaction(getDb(), callback, options)`
 *
 * @param {Function} callback - Async function receiving (trx)
 * @param {Object} [options]
 * @returns {Promise<*>}
 */
async function transaction(callback, options = {}) {
  const currentDb = getDb();
  return withTransaction(currentDb, callback, options);
}

module.exports = {
  getDb,
  setDb,
  closeDb,
  withConnection,
  getPoolStats,
  withTransaction,
  transaction,
  sortIds,
  lockRows,
  isDeadlockOrSerializationError,
};
