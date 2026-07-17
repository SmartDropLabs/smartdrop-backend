'use strict';

const logger = require('../../logger');

/**
 * A per-source circuit breaker for permanent (nonRetryable) failures like an
 * invalid/revoked API key. Distinct from ordinary transient failures (network
 * blips, rate limits): those already self-heal on the next fetch cycle and
 * are intentionally left untouched by this module.
 *
 * State is process-local (module-level, one instance per source per
 * process) — acceptable because it only affects retry cadence, not
 * correctness; each horizontally-scaled replica independently rate-limits
 * its own calls to a known-broken source rather than sharing a single
 * circuit (see #98 for the analogous cross-replica coordination gap in
 * scheduled jobs).
 */
function createCircuitBreaker({ sourceName, cooldownMs, reminderIntervalMs }) {
  let openUntil = 0;
  let lastReminderLoggedAt = 0;

  function isOpen() {
    return Date.now() < openUntil;
  }

  /** Call when a fetch is skipped because the circuit is open. Logs at most once per reminderIntervalMs, not once per skipped attempt. */
  function noteSkipped(context = {}) {
    const now = Date.now();
    if (now - lastReminderLoggedAt >= reminderIntervalMs) {
      logger.warn('Price source circuit open, skipping fetch', {
        source: sourceName,
        openUntil: new Date(openUntil).toISOString(),
        ...context,
      });
      lastReminderLoggedAt = now;
    }
  }

  /** Call on a nonRetryable failure. Logs distinctly (error level) only the first time the circuit transitions from closed to open. */
  function open(context = {}) {
    const wasOpen = isOpen();
    openUntil = Date.now() + cooldownMs;
    if (!wasOpen) {
      logger.error('Price source permanently misconfigured', {
        source: sourceName,
        cooldownMs,
        ...context,
      });
      lastReminderLoggedAt = Date.now();
    }
  }

  /** Call on a successful fetch. No-op if the circuit was already closed. */
  function close() {
    openUntil = 0;
    lastReminderLoggedAt = 0;
  }

  function getState() {
    return {
      source: sourceName,
      open: isOpen(),
      openUntil: openUntil ? new Date(openUntil).toISOString() : null,
    };
  }

  return { isOpen, noteSkipped, open, close, getState };
}

module.exports = { createCircuitBreaker };
