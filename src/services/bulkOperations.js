'use strict';

/**
 * Bulk operations service & Express handler factory (#522).
 *
 * Eliminates N-request round-trip overhead by executing batch create, update,
 * and delete operations in a single request with bounded batch sizes,
 * configurable concurrency, and detailed per-item status reporting (including
 * HTTP 207 Multi-Status support for partial successes).
 */

const DEFAULT_MAX_BATCH_SIZE = 500;
const DEFAULT_CONCURRENCY = 10;

class BulkOperationsService {
  constructor(options = {}) {
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  }

  /**
   * Validates that `items` is a non-empty array within `maxBatchSize`.
   */
  validateBatch(items) {
    if (!Array.isArray(items)) {
      const err = new Error('Bulk payload "items" must be an array');
      err.statusCode = 400;
      err.code = 'INVALID_BULK_PAYLOAD';
      throw err;
    }
    if (items.length === 0) {
      const err = new Error('Bulk payload "items" cannot be empty');
      err.statusCode = 400;
      err.code = 'EMPTY_BULK_PAYLOAD';
      throw err;
    }
    if (items.length > this.maxBatchSize) {
      const err = new Error(
        `Bulk payload exceeds maximum batch size of ${this.maxBatchSize} items`
      );
      err.statusCode = 413;
      err.code = 'BULK_BATCH_LIMIT_EXCEEDED';
      throw err;
    }
  }

  /**
   * Executes an async `operationFn(item, index)` across `items` with bounded
   * concurrency.
   *
   * @param {Array} items - Batch items to process
   * @param {Function} operationFn - Async function `(item, index) => result`
   * @param {Object} [options={}] - `{ atomic: boolean }`
   * @returns {Promise<{ total: number, succeeded: number, failed: number, results: Array, durationMs: number }>}
   */
  async executeBatch(items, operationFn, options = {}) {
    this.validateBatch(items);
    if (typeof operationFn !== 'function') {
      throw new Error('operationFn must be a function');
    }

    const startTime = Date.now();
    const atomic = Boolean(options.atomic);
    const results = new Array(items.length);
    let succeeded = 0;
    let failed = 0;
    let cursor = 0;
    let abortedError = null;

    const workerCount = Math.min(this.concurrency, items.length);

    const runWorker = async () => {
      while (cursor < items.length) {
        if (atomic && abortedError) return;
        const index = cursor;
        cursor += 1;
        const item = items[index];

        try {
          const data = await operationFn(item, index);
          results[index] = {
            index,
            status: 'fulfilled',
            data,
          };
          succeeded += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          results[index] = {
            index,
            status: 'rejected',
            error: message,
            code: err?.code || 'OPERATION_FAILED',
          };
          failed += 1;
          if (atomic && !abortedError) {
            abortedError = err instanceof Error ? err : new Error(message);
          }
        }
      }
    };

    const workers = [];
    for (let i = 0; i < workerCount; i += 1) {
      workers.push(runWorker());
    }
    await Promise.all(workers);

    if (atomic && abortedError) {
      const atomicErr = new Error(
        `Atomic bulk operation aborted: ${abortedError.message}`
      );
      atomicErr.statusCode = abortedError.statusCode || 400;
      atomicErr.code = 'ATOMIC_BULK_ABORTED';
      atomicErr.results = results.filter(Boolean);
      throw atomicErr;
    }

    return {
      total: items.length,
      succeeded,
      failed,
      results,
      durationMs: Math.max(0, Date.now() - startTime),
    };
  }

  async bulkCreate(items, store, options = {}) {
    return this.executeBatch(items, (item) => store.create(item), options);
  }

  async bulkUpdate(items, store, options = {}) {
    return this.executeBatch(
      items,
      async (item) => {
        if (!item || !item.id) {
          throw new Error('Each bulk update item requires an "id"');
        }
        const updated = await store.update(item.id, item.data ?? item);
        if (!updated) {
          const notFound = new Error(`Resource not found: ${item.id}`);
          notFound.code = 'NOT_FOUND';
          throw notFound;
        }
        return updated;
      },
      options
    );
  }

  async bulkDelete(ids, store, options = {}) {
    return this.executeBatch(
      ids,
      async (id) => {
        const rawId = typeof id === 'object' && id !== null ? id.id : id;
        if (!rawId || typeof rawId !== 'string') {
          throw new Error('Each bulk delete entry must be a non-empty id');
        }
        const removed = await store.remove(rawId);
        if (!removed) {
          const notFound = new Error(`Resource not found: ${rawId}`);
          notFound.code = 'NOT_FOUND';
          throw notFound;
        }
        return { id: rawId, deleted: true };
      },
      options
    );
  }

  /**
   * Creates Express route handlers (`create`, `update`, `delete`) backed by a
   * target store (`{ create, update, remove }`).
   */
  createHandlers(store) {
    const respond = (res, summary, successCode = 200) => {
      if (summary.failed === 0) {
        return res.status(successCode).json(summary);
      }
      if (summary.succeeded > 0) {
        return res.status(207).json(summary);
      }
      return res.status(400).json(summary);
    };

    const handleError = (res, err) => {
      const status = err.statusCode || 400;
      return res.status(status).json({
        error: err.message,
        code: err.code || 'BULK_ERROR',
      });
    };

    return {
      create: async (req, res) => {
        try {
          const summary = await this.bulkCreate(req.body?.items, store, {
            atomic: req.body?.atomic,
          });
          return respond(res, summary, 201);
        } catch (err) {
          return handleError(res, err);
        }
      },
      update: async (req, res) => {
        try {
          const summary = await this.bulkUpdate(req.body?.items, store, {
            atomic: req.body?.atomic,
          });
          return respond(res, summary, 200);
        } catch (err) {
          return handleError(res, err);
        }
      },
      delete: async (req, res) => {
        try {
          const items = req.body?.ids ?? req.body?.items;
          const summary = await this.bulkDelete(items, store, {
            atomic: req.body?.atomic,
          });
          return respond(res, summary, 200);
        } catch (err) {
          return handleError(res, err);
        }
      },
    };
  }
}

const defaultBulkOperations = new BulkOperationsService();

module.exports = {
  BulkOperationsService,
  bulkOperations: defaultBulkOperations,
};
