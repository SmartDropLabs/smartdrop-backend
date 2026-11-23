'use strict';

const logger = require('../logger');

/**
 * #454, #500 & #724 — Database transaction manager with guaranteed rollback, error preservation,
 * configurable isolation levels, and deadlock/serialization failure prevention and automatic retry.
 *
 * Causes of deadlocks & serialization failures in relational transactions:
 * 1. Inconsistent lock acquisition order across transactions touching multiple rows/tables.
 * 2. Overly broad locks (e.g. exclusive FOR UPDATE when FOR NO KEY UPDATE suffices).
 * 3. Long-running transactions that perform external I/O or heavy computation inside transactions.
 * 4. Missing indexes causing full-table scans that escalate lock contention.
 *
 * This module guarantees:
 * - The callback receives the transaction client `trx` for all transactional queries.
 * - Any error thrown inside the callback triggers an immediate `trx.rollback()`.
 * - The ORIGINAL error thrown by the callback is ALWAYS preserved.
 * - Isolation level is configurable (#724) with case-insensitive normalization (e.g. 'READ COMMITTED').
 * - Automatic retry on deadlock (PostgreSQL 40P01) and serialization failure (PostgreSQL 40001)
 *   with exponential backoff, jitter, and bounded attempts.
 * - All other errors are rethrown immediately without retrying.
 * - Helper utilities to enforce consistent row lock ordering and narrow locking modes.
 */

const DEADLOCK_ERROR_CODES = Object.freeze(['40P01', '40001', 'DEADLOCK_DETECTED']);

/**
 * Supported SQL transaction isolation levels (#724).
 */
const ISOLATION_LEVELS = Object.freeze({
  READ_UNCOMMITTED: 'read uncommitted',
  READ_COMMITTED: 'read committed',
  REPEATABLE_READ: 'repeatable read',
  SERIALIZABLE: 'serializable',
  SNAPSHOT: 'snapshot',
});

const VALID_ISOLATION_LEVELS = Object.freeze(Object.values(ISOLATION_LEVELS));

/**
 * Normalize and validate an SQL transaction isolation level (#724).
 * Converts case-insensitively (e.g., 'READ COMMITTED' -> 'read committed').
 *
 * @param {string} level
 * @returns {string|undefined}
 */
function normalizeIsolationLevel(level) {
  if (!level) return undefined;
  const normalized = String(level).trim().toLowerCase();
  if (!VALID_ISOLATION_LEVELS.includes(normalized)) {
    throw new Error(
      `Invalid isolationLevel "${level}", supported isolation levels are: ${JSON.stringify(VALID_ISOLATION_LEVELS)}`
    );
  }
  return normalized;
}

/**
 * Identifies if an error is a PostgreSQL deadlock or serialization failure.
 *
 * @param {Error} err
 * @returns {boolean}
 */
function isDeadlockOrSerializationError(err) {
  if (!err) return false;
  if (err.code && DEADLOCK_ERROR_CODES.includes(String(err.code).toUpperCase())) {
    return true;
  }
  const msg = String(err.message || '').toLowerCase();
  return (
    msg.includes('deadlock detected') ||
    msg.includes('could not serialize access') ||
    msg.includes('serialization failure') ||
    msg.includes('deadlock')
  );
}

/**
 * Sorts an array of IDs or keys into consistent natural/lexicographical order
 * to prevent AB-BA deadlock cycles when locking multiple rows.
 *
 * @param {Array<string|number>} ids
 * @returns {Array<string|number>} Sorted copy
 */
function sortIds(ids) {
  if (!Array.isArray(ids)) return [];
  return [...ids].sort((a, b) => {
    if (typeof a === 'number' && typeof b === 'number') {
      return a - b;
    }
    return String(a).localeCompare(String(b));
  });
}

/**
 * Query builder helper to acquire locks in consistent sorted ID order using the narrowest lock.
 *
 * @param {import('knex').Knex.Transaction} trx - Active transaction client
 * @param {string} table - Table name
 * @param {Array<string|number>} ids - Row identifiers to lock
 * @param {Object} [options]
 * @param {'forUpdate'|'forNoKeyUpdate'|'forShare'|'forKeyShare'} [options.lockMode='forUpdate']
 * @param {boolean} [options.skipLocked=false]
 * @param {boolean} [options.noWait=false]
 * @param {string} [options.idColumn='id']
 * @returns {Promise<Array>}
 */
async function lockRows(trx, table, ids, options = {}) {
  const sortedIds = sortIds(ids);
  if (sortedIds.length === 0) return [];

  const {
    lockMode = 'forUpdate',
    skipLocked = false,
    noWait = false,
    idColumn = 'id',
  } = options;

  let query = trx(table).whereIn(idColumn, sortedIds).orderBy(idColumn, 'asc');

  switch (lockMode) {
    case 'forNoKeyUpdate':
      // PostgreSQL FOR NO KEY UPDATE: narrower than FOR UPDATE, allows concurrent FOR KEY SHARE
      if (skipLocked) {
        return trx.raw(
          `SELECT * FROM ?? WHERE ?? = ANY(?) ORDER BY ?? ASC FOR NO KEY UPDATE SKIP LOCKED`,
          [table, idColumn, sortedIds, idColumn]
        ).then((res) => res.rows || res);
      }
      if (noWait) {
        return trx.raw(
          `SELECT * FROM ?? WHERE ?? = ANY(?) ORDER BY ?? ASC FOR NO KEY UPDATE NOWAIT`,
          [table, idColumn, sortedIds, idColumn]
        ).then((res) => res.rows || res);
      }
      return trx.raw(
        `SELECT * FROM ?? WHERE ?? = ANY(?) ORDER BY ?? ASC FOR NO KEY UPDATE`,
        [table, idColumn, sortedIds, idColumn]
      ).then((res) => res.rows || res);

    case 'forKeyShare':
      if (skipLocked) {
        return trx.raw(
          `SELECT * FROM ?? WHERE ?? = ANY(?) ORDER BY ?? ASC FOR KEY SHARE SKIP LOCKED`,
          [table, idColumn, sortedIds, idColumn]
        ).then((res) => res.rows || res);
      }
      return trx.raw(
        `SELECT * FROM ?? WHERE ?? = ANY(?) ORDER BY ?? ASC FOR KEY SHARE`,
        [table, idColumn, sortedIds, idColumn]
      ).then((res) => res.rows || res);

    case 'forShare':
      query = query.forShare();
      break;

    case 'forUpdate':
    default:
      query = query.forUpdate();
      break;
  }

  if (skipLocked) {
    query = query.skipLocked();
  } else if (noWait) {
    query = query.noWait();
  }

  return query;
}

/**
 * Execute a single transaction attempt.
 */
async function executeSingleTransaction(db, callback, options = {}) {
  // If already inside an existing transaction, support nested savepoints
  if (options.trx) {
    const parentTrx = options.trx;
    const savepoint = await parentTrx.transaction();
    let completed = false;
    try {
      const result = await callback(savepoint);
      if (!savepoint.isCompleted()) {
        await savepoint.commit();
      }
      completed = true;
      return result;
    } catch (err) {
      if (!completed && !savepoint.isCompleted()) {
        try {
          await savepoint.rollback();
        } catch (rollbackErr) {
          logger.warn('Savepoint rollback error (suppressed, preserving original)', {
            error: rollbackErr.message,
          });
        }
      }
      throw err;
    }
  }

  // Start a new transaction with configurable isolation level (#724)
  const trxConfig = {};
  const isolationLevel = normalizeIsolationLevel(options.isolationLevel);
  if (isolationLevel) {
    trxConfig.isolationLevel = isolationLevel;
  }

  const trx = await db.transaction(trxConfig);
  let committed = false;

  try {
    const result = await callback(trx);
    if (!trx.isCompleted()) {
      await trx.commit();
    }
    committed = true;
    return result;
  } catch (err) {
    if (!committed && !trx.isCompleted()) {
      try {
        await trx.rollback();
      } catch (rollbackErr) {
        logger.warn('Transaction rollback error (suppressed, preserving original)', {
          original_error: err.message,
          rollback_error: rollbackErr.message,
        });
      }
    }
    throw err;
  } finally {
    if (!trx.isCompleted()) {
      try {
        await trx.rollback();
      } catch (_) {}
    }
  }
}

/**
 * Execute a callback within an atomic database transaction with deadlock/serialization retry.
 *
 * @param {import('knex').Knex} db - The Knex database instance
 * @param {Function} callback - Async function receiving `(trx)` to execute transactional queries
 * @param {Object} [options] - Optional transaction configuration
 * @param {import('knex').Knex.Transaction} [options.trx] - Existing transaction for nesting
 * @param {string} [options.isolationLevel] - Optional SQL isolation level (e.g., 'READ COMMITTED') (#724)
 * @param {number} [options.maxRetries=3] - Maximum retry attempts on deadlock
 * @param {number} [options.baseDelayMs=25] - Base delay for exponential backoff
 * @param {number} [options.maxDelayMs=500] - Maximum backoff delay cap
 * @param {Function} [options.sleep] - Optional sleep implementation for tests
 * @returns {Promise<*>} The result of the callback
 */
async function withTransaction(db, callback, options = {}) {
  if (!db || typeof db !== 'function') {
    throw new Error('withTransaction: valid Knex database instance is required');
  }
  if (typeof callback !== 'function') {
    throw new Error('withTransaction: callback function is required');
  }

  // If running within an existing parent transaction, do not retry locally;
  // let the outer top-level transaction handle retry if deadlock occurs.
  if (options.trx) {
    return executeSingleTransaction(db, callback, options);
  }

  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 25;
  const maxDelayMs = options.maxDelayMs ?? 500;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  let attempt = 0;

  while (true) {
    try {
      return await executeSingleTransaction(db, callback, options);
    } catch (err) {
      const isDeadlock = isDeadlockOrSerializationError(err);
      if (!isDeadlock || attempt >= maxRetries) {
        throw err;
      }

      attempt += 1;
      const jitter = Math.random() * (baseDelayMs * 0.5);
      const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1) + jitter);

      logger.warn('Deadlock or serialization failure detected, retrying transaction', {
        attempt,
        maxRetries,
        code: err.code,
        error: err.message,
        delayMs: Math.round(delay),
      });

      await sleep(delay);
    }
  }
}

/**
 * Execute a transaction with configurable isolation level (#724).
 * Supports both:
 *   transaction(db, callback, options)
 *   transaction(callback, options) (uses default database)
 *
 * @param {import('knex').Knex|Function} dbOrCallback
 * @param {Function|Object} [callbackOrOptions]
 * @param {Object} [options]
 * @returns {Promise<*>}
 */
async function transaction(dbOrCallback, callbackOrOptions, options = {}) {
  if (typeof dbOrCallback === 'function' && typeof callbackOrOptions !== 'function') {
    const { getDb } = require('./index');
    return withTransaction(getDb(), dbOrCallback, callbackOrOptions || {});
  }
  return withTransaction(dbOrCallback, callbackOrOptions, options);
}

module.exports = {
  withTransaction,
  transaction,
  isDeadlockOrSerializationError,
  DEADLOCK_ERROR_CODES,
  ISOLATION_LEVELS,
  VALID_ISOLATION_LEVELS,
  normalizeIsolationLevel,
  sortIds,
  lockRows,
};
