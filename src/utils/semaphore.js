'use strict';

/**
 * A simple counting semaphore for limiting concurrent access to a resource.
 * Used to prevent Redis connection pool exhaustion under high load (issue #249).
 */
class Semaphore {
  constructor(maxConcurrency) {
    this._maxConcurrency = maxConcurrency;
    this._current = 0;
    this._queue = [];
  }

  get available() {
    return this._maxConcurrency - this._current;
  }

  get waiting() {
    return this._queue.length;
  }

  get active() {
    return this._current;
  }

  /**
   * Acquire a permit. Resolves when a permit is available, or immediately
   * if one is already available. Call release() when done.
   * @param {number} [timeoutMs] - Max time to wait for a permit. 0 = no wait.
   * @returns {Promise<function>} A release function.
   */
  acquire(timeoutMs = 0) {
    if (this._current < this._maxConcurrency) {
      this._current++;
      return Promise.resolve(() => this._release());
    }

    if (timeoutMs === 0) {
      return Promise.reject(new Error('Semaphore: no permits available'));
    }

    return new Promise((resolve, reject) => {
      const entry = { resolve: () => {
        this._current++;
        resolve(() => this._release());
      }, reject };

      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          const idx = this._queue.indexOf(entry);
          if (idx !== -1) this._queue.splice(idx, 1);
          reject(new Error(`Semaphore: timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      this._queue.push(entry);
    });
  }

  _release() {
    this._current--;
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      if (next.timer) clearTimeout(next.timer);
      next.resolve();
    }
  }
}

module.exports = Semaphore;
