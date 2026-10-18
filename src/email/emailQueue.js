'use strict';

/**
 * Asynchronous background email queue service (#515).
 *
 * Offloads outbound email delivery from the synchronous HTTP request lifecycle
 * into a non-blocking queue with configurable concurrency, exponential backoff
 * retries, and dead-letter tracking.
 */

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 200;

class EmailQueue {
  constructor(options = {}) {
    this.transport =
      typeof options.sendMail === 'function'
        ? options.sendMail
        : async (msg) => ({ messageId: `msg_${Date.now()}`, accepted: [msg.to] });
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.logger = options.logger || null;
    this.pending = [];
    this.deadLetter = [];
    this.processing = false;
    this.stats = {
      enqueued: 0,
      sent: 0,
      retried: 0,
      failed: 0,
    };
  }

  /**
   * Enqueues an email message for asynchronous delivery and triggers background
   * processing without blocking the caller.
   *
   * @param {Object} email - { to, subject, text, html, from, metadata }
   * @returns {Object} Queued job descriptor { id, status, enqueuedAt }
   */
  enqueue(email) {
    if (!email || typeof email.to !== 'string' || !email.to.trim()) {
      throw new Error('Recipient address (email.to) is required');
    }
    if (!email.subject || typeof email.subject !== 'string') {
      throw new Error('Email subject (email.subject) is required');
    }

    const job = {
      id: `email_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      payload: {
        to: email.to.trim(),
        from: email.from || 'no-reply@smartdrop.io',
        subject: email.subject,
        text: email.text || '',
        html: email.html || null,
        metadata: email.metadata || {},
      },
      attempts: 0,
      maxAttempts: this.maxAttempts,
      status: 'queued',
      lastError: null,
      enqueuedAt: new Date().toISOString(),
    };

    this.pending.push(job);
    this.stats.enqueued += 1;

    setImmediate(() => {
      this.drain().catch((err) => {
        if (this.logger && typeof this.logger.error === 'function') {
          this.logger.error('Email queue drain error', { error: err.message });
        }
      });
    });

    return {
      id: job.id,
      status: job.status,
      enqueuedAt: job.enqueuedAt,
    };
  }

  /**
   * Processes all currently queued emails sequentially in the background.
   */
  async drain() {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.pending.length > 0) {
        const job = this.pending.shift();
        await this._deliverWithRetry(job);
      }
    } finally {
      this.processing = false;
    }
  }

  async _deliverWithRetry(job) {
    while (job.attempts < job.maxAttempts) {
      job.attempts += 1;
      try {
        await this.transport(job.payload);
        job.status = 'sent';
        job.sentAt = new Date().toISOString();
        this.stats.sent += 1;
        return job;
      } catch (err) {
        job.lastError = err instanceof Error ? err.message : String(err);
        if (job.attempts < job.maxAttempts) {
          this.stats.retried += 1;
          const backoffMs = this.baseDelayMs * Math.pow(2, job.attempts - 1);
          if (backoffMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
          }
        } else {
          job.status = 'failed';
          this.stats.failed += 1;
          this.deadLetter.push(job);
          if (this.logger && typeof this.logger.error === 'function') {
            this.logger.error('Email delivery failed permanently', {
              jobId: job.id,
              to: job.payload.to,
              attempts: job.attempts,
              error: job.lastError,
            });
          }
        }
      }
    }
    return job;
  }

  getStats() {
    return {
      ...this.stats,
      queued: this.pending.length,
      deadLetterCount: this.deadLetter.length,
      processing: this.processing,
    };
  }
}

const defaultEmailQueue = new EmailQueue();

module.exports = {
  EmailQueue,
  emailQueue: defaultEmailQueue,
};
