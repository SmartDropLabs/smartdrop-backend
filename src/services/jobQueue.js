'use strict';

/**
 * Async job queue for offloading heavy tasks from the request path (#510).
 *
 * Provides a simple in-process job queue backed by Redis for persistence.
 * Heavy tasks (webhook dispatch, bulk operations, report generation) can
 * be enqueued and processed in the background, keeping HTTP requests fast.
 *
 * Usage:
 *   const jobQueue = require('../services/jobQueue');
 *   jobQueue.start();
 *   jobQueue.enqueue('webhook-dispatch', { eventType, eventId, data });
 */

const cache = require('./cache');
const logger = require('../logger');

const QUEUE_KEY = 'jobs:queue';
const PROCESSING_KEY = 'jobs:processing';
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
// Jobs that exhaust their retries are kept here for manual review (#623)
// instead of being dropped. Capped and expiring so the list can't grow
// without bound if a downstream provider is down for a long time.
const DEAD_LETTER_KEY = 'jobs:dead';
const DEAD_LETTER_MAX = 1000;
const DEAD_LETTER_TTL_SECONDS = 30 * 24 * 60 * 60;

class JobQueue {
  constructor() {
    this.handlers = new Map();
    this.running = false;
    this.timer = null;
    this.concurrency = DEFAULT_CONCURRENCY;
    this.activeJobs = 0;
    this.stats = {
      enqueued: 0,
      processed: 0,
      failed: 0,
      retried: 0,
      deadLettered: 0,
    };
  }

  /**
   * Register a handler for a job type.
   * @param {string} type - Job type identifier
   * @param {Function} handler - Async (job) => result
   */
  register(type, handler) {
    this.handlers.set(type, handler);
    logger.info(`Job handler registered: ${type}`);
  }

  /**
   * Enqueue a job for background processing.
   * @param {string} type - Job type
   * @param {Object} data - Job payload
   * @returns {string} Job ID
   */
  async enqueue(type, data = {}) {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      id: jobId,
      type,
      data,
      attempts: 0,
      maxRetries: MAX_RETRIES,
      enqueuedAt: new Date().toISOString(),
    };

    const redis = cache.getClient();
    await redis.lpush(QUEUE_KEY, JSON.stringify(job));
    this.stats.enqueued++;
    logger.debug(`Job enqueued: ${type} (${jobId})`);
    return jobId;
  }

  /**
   * Start processing jobs from the queue.
   */
  start(concurrency = DEFAULT_CONCURRENCY, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS) {
    if (this.running) return;
    this.running = true;
    this.concurrency = concurrency;
    this.timer = setInterval(() => this._processNext(), pollIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    logger.info(`Job queue started (concurrency=${concurrency}, poll=${pollIntervalMs}ms)`);
  }

  /**
   * Stop processing jobs.
   */
  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Job queue stopped');
    }
  }

  async _processNext() {
    if (!this.running || this.activeJobs >= this.concurrency) return;

    const redis = cache.getClient();
    // Atomically move a job from queue to processing (BRPOPLPUSH pattern)
    const raw = await redis.rpoplpush(QUEUE_KEY, PROCESSING_KEY);
    if (!raw) return;

    let job;
    try {
      job = JSON.parse(raw);
    } catch {
      await redis.lrem(PROCESSING_KEY, 1, raw);
      return;
    }

    this.activeJobs++;
    try {
      await this._executeJob(job);
    } finally {
      this.activeJobs--;
      await redis.lrem(PROCESSING_KEY, 1, raw);
    }
  }

  async _executeJob(job) {
    const handler = this.handlers.get(job.type);
    if (!handler) {
      logger.warn(`No handler for job type: ${job.type}`, { jobId: job.id });
      this.stats.failed++;
      return;
    }

    try {
      await handler(job);
      this.stats.processed++;
      logger.debug(`Job completed: ${job.type} (${job.id})`);
    } catch (err) {
      job.attempts++;
      this.stats.failed++;

      if (job.attempts < job.maxRetries) {
        this.stats.retried++;
        logger.warn(`Job failed, retrying (${job.attempts}/${job.maxRetries})`, {
          jobId: job.id,
          type: job.type,
          error: err.message,
        });
        // Re-enqueue with incremented attempt count after a delay
        setTimeout(async () => {
          try {
            const redis = cache.getClient();
            await redis.lpush(QUEUE_KEY, JSON.stringify(job));
          } catch (requeueErr) {
            logger.error('Failed to requeue job', { jobId: job.id, error: requeueErr.message });
          }
        }, RETRY_DELAY_MS);
      } else {
        logger.error(`Job failed permanently after ${job.attempts} attempts`, {
          jobId: job.id,
          type: job.type,
          error: err.message,
        });
        await this._deadLetter(job, err);
      }
    }
  }

  /**
   * Record a permanently failed job in the dead-letter list (#623).
   * Never throws: losing the DLQ entry must not crash the worker.
   */
  async _deadLetter(job, err) {
    try {
      const redis = cache.getClient();
      const entry = {
        job,
        error: err && err.message ? err.message : String(err),
        failedAt: new Date().toISOString(),
      };
      await redis.lpush(DEAD_LETTER_KEY, JSON.stringify(entry));
      await redis.ltrim(DEAD_LETTER_KEY, 0, DEAD_LETTER_MAX - 1);
      await redis.expire(DEAD_LETTER_KEY, DEAD_LETTER_TTL_SECONDS);
      this.stats.deadLettered++;
    } catch (dlqErr) {
      logger.error('Failed to dead-letter job', { jobId: job.id, error: dlqErr.message });
    }
  }

  /**
   * Most recent dead-lettered jobs, newest first, optionally filtered by type.
   * @param {Object} [options]
   * @param {string} [options.type] - Only return jobs of this type
   * @param {number} [options.limit=100] - Maximum entries to return
   */
  async getDeadLetters({ type, limit = 100 } = {}) {
    const redis = cache.getClient();
    const raw = await redis.lrange(DEAD_LETTER_KEY, 0, DEAD_LETTER_MAX - 1);
    const entries = [];
    for (const item of raw) {
      try {
        const entry = JSON.parse(item);
        if (!type || entry.job?.type === type) entries.push(entry);
      } catch {
        // Skip a corrupt entry rather than failing the whole listing.
      }
      if (entries.length >= limit) break;
    }
    return entries;
  }

  /**
   * Get queue statistics.
   */
  getStats() {
    return { ...this.stats, active: this.activeJobs, running: this.running };
  }
}

// Singleton instance
const jobQueue = new JobQueue();
module.exports = jobQueue;
module.exports.DEAD_LETTER_KEY = DEAD_LETTER_KEY;
module.exports.DEAD_LETTER_MAX = DEAD_LETTER_MAX;
