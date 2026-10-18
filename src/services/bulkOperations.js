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
 * Express handler factory for bulk endpoints.
 *
 * @param {Function} operationHandler - async (item) => result
 * @param {string} itemName - Name of the item type for error messages
 * @returns {Function} Express route handler
 */
function bulkHandler(operationHandler, itemName = 'item') {
  return async (req, res, next) => {
    try {
      const items = req.body?.items;
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: `Request body must contain an 'items' array with at least one ${itemName}` });
      }
      if (items.length > 100) {
        return res.status(400).json({ error: `Batch size limited to 100 ${itemName}s per request` });
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
  bulkHandler,
};
