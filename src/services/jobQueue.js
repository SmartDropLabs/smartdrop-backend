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
      }
    }
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
