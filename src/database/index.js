'use strict';

const knexFactory = require('knex');
const config = require('../config');
const {
  withTransaction,
  sortIds,
  lockRows,
  isDeadlockOrSerializationError,
} = require('./transaction');
const encryption = require('./encryption');
const { PoolMonitor, defaultPoolMonitor } = require('./poolMonitor');
const logger = require('../logger');

let db = null;

/**
 * Get or initialize the shared Knex database singleton.
 *
 * @param {Object} [overrideConfig] - Optional configuration overrides (useful for testing)
 * @returns {import('knex').Knex}
 */
// Issue #494 — every timestamp column is TIMESTAMPTZ, and all application
// code stores/compares UTC. Pinning the session TimeZone to UTC as well means
// anything the database renders itself in a text form (to_char, ::date,
// CURRENT_TIMESTAMP without a zone, a query typed by hand) is UTC too, rather
// than following the server's local zone. A pool `afterCreate` hook runs for
// every pooled connection, not just the first.
function afterCreateUtcConnection(conn, done) {
  conn.query("SET TIME ZONE 'UTC'", (err) => done(err, conn));
}

function getDb(overrideConfig = {}) {
  if (!db) {
    const pool = {
      min: overrideConfig.pool?.min ?? config.database.pool.min ?? 2,
      max: overrideConfig.pool?.max ?? config.database.pool.max ?? 10,
      afterCreate: afterCreateUtcConnection,
      ...(overrideConfig.pool || {}),
    };
    db = knexFactory({
      client: 'pg',
      connection: overrideConfig.connection || config.databaseUrl,
      ...overrideConfig,
      pool,
    });
    defaultPoolMonitor.attach(db);
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
  if (db) {
    defaultPoolMonitor.attach(db);
  } else {
    defaultPoolMonitor.detach();
  }
}

/**
 * Close and destroy the database connection pool.
 */
async function closeDb() {
  if (db) {
    defaultPoolMonitor.detach();
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
 * Get current pool statistics for monitoring connection usage (#488, #520).
 *
 * @returns {Object} Pool stats with utilization metrics
 */
function getPoolStats() {
  const currentDb = getDb();
  const pool = currentDb.client.pool;
  const snapshot = defaultPoolMonitor.getSnapshot() || {};
  return {
    min: pool ? pool.min : 0,
    max: pool ? pool.max : 10,
    used: pool && typeof pool.numUsed === 'function' ? pool.numUsed() : (snapshot.used ?? 0),
    free: pool && typeof pool.numFree === 'function' ? pool.numFree() : (snapshot.free ?? 0),
    pendingAcquires:
      pool && typeof pool.numPendingAcquires === 'function'
        ? pool.numPendingAcquires()
        : (snapshot.pendingAcquires ?? 0),
    pendingCreates:
      pool && typeof pool.numPendingCreates === 'function'
        ? pool.numPendingCreates()
        : (snapshot.pendingCreates ?? 0),
    utilization: snapshot.utilization ?? 0,
    saturation: snapshot.saturation ?? 0,
    status: snapshot.status ?? 'healthy',
  };
}

/**
 * Get full connection pool metrics, including counters and latency timing (#520).
 *
 * @returns {Object}
 */
function getPoolMetrics() {
  return defaultPoolMonitor.getMetrics();
}

/**
 * Stream query results one row at a time without loading the full result
 * set into memory (issue #560). Uses a server-side cursor so large tables
 * can be iterated without exhausting the heap.
 *
 * @param {Object} queryBuilder - Knex query builder (select)
 * @param {Function} onRow - Called with each row; return false to stop early
 * @param {Object} [options]
 * @param {number} [options.batchSize=100] - Rows fetched per cursor round-trip
 * @returns {Promise<number>} Total rows processed
 */
async function streamQuery(queryBuilder, onRow, { batchSize = 100 } = {}) {
  const currentDb = getDb();
  const conn = await currentDb.client.acquireConnection();
  let processed = 0;
  try {
    // Knex's .stream() returns a Readable in object mode; we process rows
    // one at a time and pause when the consumer needs back-pressure.
    const stream = queryBuilder.connection(conn).stream({ highWaterMark: batchSize });
    for await (const row of stream) {
      const result = onRow(row, processed);
      processed += 1;
      if (result === false) break;
    }
  } finally {
    currentDb.client.releaseConnection(conn);
  }
  return processed;
}

/**
 * Iterate query results in batches without holding the full result set in
 * memory (issue #560). Each batch is an array of at most `batchSize` rows.
 *
 * @param {Object} queryBuilder - Knex query builder with an ORDER BY
 * @param {Function} onBatch - Called with each array of rows; return false to stop
 * @param {Object} [options]
 * @param {number} [options.batchSize=100] - Rows per batch
 * @param {string} [options.idColumn='id'] - Column used as the cursor key
 * @returns {Promise<number>} Total rows processed
 */
async function streamBatches(queryBuilder, onBatch, { batchSize = 100, idColumn = 'id' } = {}) {
  let lastId = null;
  let processed = 0;
  for (;;) {
    let q = queryBuilder.clone().limit(batchSize);
    if (lastId !== null) {
      q = q.where(idColumn, '>', lastId);
    }
    const rows = await q;
    if (rows.length === 0) break;
    const result = onBatch(rows, processed);
    processed += rows.length;
    if (result === false) break;
    if (rows.length < batchSize) break;
    lastId = rows[rows.length - 1][idColumn];
  }
  return processed;
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
  getPoolMetrics,
  streamQuery,
  streamBatches,
  PoolMonitor,
  defaultPoolMonitor,
  withTransaction,
  transaction,
  sortIds,
  lockRows,
  isDeadlockOrSerializationError,
  // Encryption at rest (#519)
  encryption,
  encrypt: encryption.encrypt,
  decrypt: encryption.decrypt,
  isEncrypted: encryption.isEncrypted,
  encryptRecord: encryption.encryptRecord,
  decryptRecord: encryption.decryptRecord,
  encryptRow: encryption.encryptRow,
  decryptRow: encryption.decryptRow,
  encryptFields: encryption.encryptFields,
  decryptFields: encryption.decryptFields,
  encryptRows: encryption.encryptRows,
  decryptRows: encryption.decryptRows,
  hashBlindIndex: encryption.hashBlindIndex,
};
