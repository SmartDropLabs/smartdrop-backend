'use strict';

const logger = require('../logger');

/**
 * Account lockout mechanism (#512).
 *
 * Tracks failed login attempts per identifier and locks the account after
 * a configurable threshold. Prevents brute force and credential stuffing.
 *
 * Uses an in-memory store by default; can be backed by Redis for
 * multi-instance deployments.
 */

const DEFAULTS = {
  maxFailedAttempts: 5,
  lockoutDurationMs: 15 * 60 * 1000, // 15 minutes
  windowMs: 60 * 60 * 1000, // 1 hour — attempts older than this are pruned
};

class AccountLockout {
  constructor(options = {}) {
    this.maxFailedAttempts = options.maxFailedAttempts ?? DEFAULTS.maxFailedAttempts;
    this.lockoutDurationMs = options.lockoutDurationMs ?? DEFAULTS.lockoutDurationMs;
    this.windowMs = options.windowMs ?? DEFAULTS.windowMs;

    // Map<identifier, { failedAttempts: number, lockedUntil: number|null, firstFailedAt: number }>
    this.attempts = new Map();
  }

  /**
   * Check if an identifier is currently locked out.
   * @returns {{ locked: boolean, lockedUntil?: number, remainingMs?: number }}
   */
  isLocked(identifier) {
    const record = this.attempts.get(identifier);
    if (!record) return { locked: false };

    if (record.lockedUntil && Date.now() < record.lockedUntil) {
      return {
        locked: true,
        lockedUntil: record.lockedUntil,
        remainingMs: record.lockedUntil - Date.now(),
      };
    }

    // Lockout expired — reset the record
    if (record.lockedUntil && Date.now() >= record.lockedUntil) {
      this.attempts.delete(identifier);
    }

    return { locked: false };
  }

  /**
   * Record a failed login attempt. Returns lockout status after recording.
   * @returns {{ locked: boolean, lockedUntil?: number, failedAttempts: number }}
   */
  recordFailure(identifier) {
    let record = this.attempts.get(identifier);

    if (!record) {
      record = { failedAttempts: 0, lockedUntil: null, firstFailedAt: Date.now() };
      this.attempts.set(identifier, record);
    }

    // Prune old attempts outside the window
    if (Date.now() - record.firstFailedAt > this.windowMs) {
      record.failedAttempts = 0;
      record.firstFailedAt = Date.now();
      record.lockedUntil = null;
    }

    record.failedAttempts += 1;

    if (record.failedAttempts >= this.maxFailedAttempts) {
      record.lockedUntil = Date.now() + this.lockoutDurationMs;
      logger.warn({
        identifier,
        failedAttempts: record.failedAttempts,
        lockedUntil: new Date(record.lockedUntil).toISOString(),
      }, 'Account locked after failed login attempts');
    }

    return {
      locked: record.lockedUntil !== null && Date.now() < record.lockedUntil,
      lockedUntil: record.lockedUntil ?? undefined,
      failedAttempts: record.failedAttempts,
    };
  }

  /**
   * Record a successful login — resets the failed attempt counter.
   */
  recordSuccess(identifier) {
    this.attempts.delete(identifier);
  }

  /**
   * Manually unlock an identifier (admin action).
   */
  unlock(identifier) {
    this.attempts.delete(identifier);
    logger.info({ identifier }, 'Account manually unlocked');
  }

  /**
   * Get current attempt count for an identifier.
   */
  getFailedAttempts(identifier) {
    return this.attempts.get(identifier)?.failedAttempts ?? 0;
  }
}

// Singleton instance
const defaultLockout = new AccountLockout();

module.exports = {
  AccountLockout,
  defaultLockout,
};
