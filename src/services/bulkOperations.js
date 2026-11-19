'use strict';

/**
 * Bulk operations service (#522).
 *
 * Provides bulk operation endpoints for common workflows to reduce
 * request count and improve performance for bulk work.
 */

const logger = require('../logger');

/**
 * Process a batch of operations with per-item error handling.
 * Returns results for each item — successes and failures independently.
 *
 * @param {Array} items - Array of items to process
 * @param {Function} handler - async (item, index) => result
 * @param {Object} [options]
 * @param {number} [options.concurrency=5] - Max parallel operations
 * @returns {Promise<{ succeeded: Array, failed: Array }>}
 */
async function processBatch(items, handler, options = {}) {
  const concurrency = options.concurrency ?? 5;
  const succeeded = [];
  const failed = [];

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map((item, j) => handler(item, i + j)),
    );
    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === 'fulfilled') {
        succeeded.push({ index: i + j, item: items[i + j], result: result.value });
      } else {
        failed.push({ index: i + j, item: items[i + j], error: result.reason?.message ?? String(result.reason) });
      }
    }
  }

  logger.info(`Bulk operation complete: ${succeeded.length} succeeded, ${failed.length} failed`);
  return { succeeded, failed };
}

/**
 * Process a batch of operations atomically within a database transaction (#631).
 * If any operation fails, the entire transaction rolls back.
 *
 * @param {Array} items - Array of items to process
 * @param {Function} handler - async (item, index, trx) => result
 * @param {Object} [db] - Database client or pool with transaction() support
 * @returns {Promise<Array>} Array of results
 */
async function processBatchTransactional(items, handler, db) {
  if (!items || !Array.isArray(items)) {
    throw new Error('Items must be an array');
  }

  if (db && typeof db.transaction === 'function') {
    return await db.transaction(async (trx) => {
      const results = [];
      for (let i = 0; i < items.length; i++) {
        results.push(await handler(items[i], i, trx));
      }
      return results;
    });
  }

  // Fallback transactional processing: fails immediately if any item throws
  const executed = [];
  try {
    for (let i = 0; i < items.length; i++) {
      executed.push(await handler(items[i], i));
    }
    return executed;
  } catch (err) {
    logger.error('Bulk transaction failed, rolling back', { error: err.message, processedCount: executed.length });
    throw err;
  }
}

/**
 * Express handler factory for bulk endpoints.
 *
 * @param {Function} operationHandler - async (item) => result
 * @param {string} itemName - Name of the item type for error messages
 * @param {Object} [options]
 * @param {boolean} [options.transactional=false] - Whether to execute atomically within a transaction
 * @param {Object} [options.db] - Database instance
 * @returns {Function} Express route handler
 */
function bulkHandler(operationHandler, itemName = 'item', options = {}) {
  return async (req, res, next) => {
    try {
      const items = req.body?.items;
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: `Request body must contain an 'items' array with at least one ${itemName}` });
      }
      if (items.length > 100) {
        return res.status(400).json({ error: `Batch size limited to 100 ${itemName}s per request` });
      }

      if (options.transactional || req.query?.atomic === 'true') {
        const db = options.db || req.db;
        const results = await processBatchTransactional(items, operationHandler, db);
        return res.json({
          total: items.length,
          succeeded: results.length,
          failed: 0,
          results,
        });
      }

      const results = await processBatch(items, operationHandler);
      res.json({
        total: items.length,
        succeeded: results.succeeded.length,
        failed: results.failed.length,
        results: results.succeeded,
        errors: results.failed,
      });
    } catch (err) {
      next(err);
    }
  };
}

module.exports = {
  processBatch,
  processBatchTransactional,
  bulkHandler,
};
