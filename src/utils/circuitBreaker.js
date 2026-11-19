'use strict';

const logger = require('../logger');

const STATES = Object.freeze({
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half-open',
});

/**
 * Distinct typed error thrown when calls fail fast while the circuit breaker is OPEN.
 * Maps to HTTP 503 Service Unavailable with Retry-After header.
 */
class CircuitBreakerOpenError extends Error {
  constructor(clientName, cooldownRemainingMs = 0) {
    const retryAfter = Math.max(1, Math.ceil(cooldownRemainingMs / 1000));
    super(`Service '${clientName}' is temporarily unavailable (circuit breaker open)`);
    this.name = 'CircuitBreakerOpenError';
    this.code = 'SERVICE_UNAVAILABLE';
    this.statusCode = 503;
    this.status = 503;
    this.clientName = clientName;
    this.retryAfter = retryAfter;
    this.isCircuitBreakerError = true;
  }
}

const DEPENDENCY_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
]);

/**
 * Determines whether an error is a genuine dependency failure (network blips,
 * connection resets, timeouts, 5xx server errors, 429 rate limits) versus a
 * client-side error (400, 401, 403, 404, validation errors).
 *
 * @param {Error} err
 * @returns {boolean}
 */
function isDependencyFailure(err) {
  if (!err) return false;
  if (err.isCircuitBreakerError) return false;

  // 1. Connection / network error codes
  if (err.code && DEPENDENCY_ERROR_CODES.has(err.code)) {
    return true;
  }

  // 2. HTTP response status
  const status = err.status || err.statusCode || err.response?.status;
  if (typeof status === 'number') {
    // 5xx errors from the remote service are genuine dependency failures
    if (status >= 500 && status < 600) return true;
    // 429 Too Many Requests indicates upstream throttling / capacity exhaustion
    if (status === 429) return true;
    // 4xx client errors (400, 401, 403, 404, 422) are NOT dependency failures
    if (status >= 400 && status < 500) return false;
  }

  // 3. Timeout message check
  const msg = String(err.message || '').toLowerCase();
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('econnrefused')) {
    return true;
  }

  // 4. Client validation error check
  if (err.isValidationError || err.isClientError || err.name === 'ValidationError') {
    return false;
  }

  // Generic unclassified errors default to counting as failures
  return true;
}

/**
 * Registry holding active circuit breakers so health & telemetry can inspect
 * their state without leaking internals.
 */
const registry = new Map();

function registerBreaker(name, breaker) {
  registry.set(name, breaker);
  return breaker;
}

function getBreaker(name) {
  return registry.get(name);
}

function getAllBreakers() {
  return Array.from(registry.values());
}

function getAllBreakerStates() {
  const states = {};
  for (const [name, breaker] of registry.entries()) {
    states[name] = breaker.getSafeState();
  }
  return states;
}

function clearRegistry() {
  registry.clear();
}

class CircuitBreaker {
  /**
   * @param {string} name - Service or client name
   * @param {Object} [options]
   * @param {number} [options.failureThreshold=3] - Failures in window before opening
   * @param {number} [options.successThreshold=1] - Consecutive successes in half-open before closing
   * @param {number} [options.timeoutMs=30000] - Cooldown duration in ms while OPEN
   * @param {number} [options.windowMs=60000] - Rolling window duration in ms
   * @param {number} [options.trialCount=1] - Allowed trial calls in HALF_OPEN
   * @param {number} [options.requestTimeoutMs=0] - Per-call request timeout in ms (0 = disabled)
   * @param {boolean} [options.throwOnOpen=false] - Whether .call() throws on OPEN vs returns null
   * @param {Function} [options.isFailure] - Custom dependency failure predicate
   * @param {Function} [options.now] - Clock function for testing
   * @param {Object} [options.logger] - Logger instance
   */
  constructor(name, options = {}) {
    this.name = name;
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 3);
    this.successThreshold = Math.max(1, options.successThreshold ?? 1);
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 30000);
    this.windowMs = Math.max(1, options.windowMs ?? 60000);
    this.trialCount = Math.max(1, options.trialCount ?? 1);
    this.requestTimeoutMs = Math.max(0, options.requestTimeoutMs ?? 0);
    this.throwOnOpen = Boolean(options.throwOnOpen);
    this.isFailure = typeof options.isFailure === 'function' ? options.isFailure : isDependencyFailure;
    this._now = options.now || Date.now;
    this._logger = options.logger || logger;

    this.state = STATES.CLOSED;
    this.failures = []; // Timestamps of failures in rolling window
    this.failureCount = 0;
    this.successCount = 0;
    this.openedAt = null;
    this.halfOpenInFlight = false;
    this.halfOpenCallsInFlight = 0;

    registerBreaker(this.name, this);
  }

  _pruneFailures() {
    const cutoff = this._now() - this.windowMs;
    this.failures = this.failures.filter((t) => t >= cutoff);
    if (this.state === STATES.CLOSED) {
      this.failureCount = this.failures.length;
    }
  }

  getFailureCount() {
    this._pruneFailures();
    return this.failureCount;
  }

  getCooldownRemainingMs() {
    if (this.state !== STATES.OPEN || !this.openedAt) return 0;
    const elapsed = this._now() - this.openedAt;
    return Math.max(0, this.timeoutMs - elapsed);
  }

  getState() {
    this._moveToHalfOpenIfReady();
    return this.state;
  }

  isOpen() {
    return this.getState() === STATES.OPEN;
  }

  getSafeState() {
    return {
      name: this.name,
      state: this.getState(),
      open: this.isOpen(),
      failure_count: this.getFailureCount(),
      cooldown_remaining_ms: this.getCooldownRemainingMs(),
    };
  }

  /**
   * Executes a call wrapped in the circuit breaker.
   * If throwOnOpen is true, throws CircuitBreakerOpenError on OPEN.
   * Otherwise returns null on OPEN (for backwards compatibility with priceOracle).
   */
  async call(fn, callOptions = {}) {
    this._moveToHalfOpenIfReady();

    const shouldThrow = callOptions.throwOnOpen ?? this.throwOnOpen;

    if (this.state === STATES.OPEN) {
      this._logger.info('Circuit breaker open, skipping source call', {
        source: this.name,
        client: this.name,
        state: this.state,
      });
      if (shouldThrow) {
        throw new CircuitBreakerOpenError(this.name, this.getCooldownRemainingMs());
      }
      return null;
    }

    if (this.state === STATES.HALF_OPEN && this.halfOpenCallsInFlight >= this.trialCount) {
      this._logger.info(
        'Circuit breaker half-open probe already in flight, skipping source call',
        {
          source: this.name,
          client: this.name,
          state: this.state,
        }
      );
      if (shouldThrow) {
        throw new CircuitBreakerOpenError(this.name, this.getCooldownRemainingMs());
      }
      return null;
    }

    const probing = this.state === STATES.HALF_OPEN;
    if (probing) {
      this.halfOpenInFlight = true;
      this.halfOpenCallsInFlight += 1;
    }

    try {
      const timeoutMs = callOptions.requestTimeoutMs ?? this.requestTimeoutMs;
      let result;
      if (timeoutMs > 0) {
        result = await this._withTimeout(fn, timeoutMs);
      } else {
        result = await fn();
      }

      this.recordSuccess();
      return result ?? null;
    } catch (err) {
      // Only count genuine dependency failures against the breaker
      if (this.isFailure(err)) {
        this.recordFailure(err);
      } else {
        this._logger.debug('Call threw non-dependency error, not counted against breaker', {
          client: this.name,
          error: err.message,
          code: err.code,
        });
      }
      throw err;
    } finally {
      if (probing) {
        this.halfOpenCallsInFlight = Math.max(0, this.halfOpenCallsInFlight - 1);
        this.halfOpenInFlight = this.halfOpenCallsInFlight > 0;
      }
    }
  }

  /**
   * Execute with mandatory fail-fast CircuitBreakerOpenError when OPEN.
   */
  async execute(fn, callOptions = {}) {
    return this.call(fn, { ...callOptions, throwOnOpen: true });
  }

  async _withTimeout(fn, timeoutMs) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`Call to '${this.name}' timed out after ${timeoutMs}ms`);
        err.code = 'ETIMEDOUT';
        err.statusCode = 504;
        reject(err);
      }, timeoutMs);
    });

    try {
      return await Promise.race([Promise.resolve(fn()), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  recordSuccess() {
    if (this.state === STATES.HALF_OPEN) {
      this.successCount += 1;
      if (this.successCount >= this.successThreshold) {
        this._transitionTo(STATES.CLOSED, { reason: 'success-threshold' });
      }
      return;
    }

    if (this.state === STATES.CLOSED) {
      this.failureCount = 0;
      this.failures = [];
    }
  }

  recordFailure(err) {
    if (this.state === STATES.HALF_OPEN) {
      this._transitionTo(STATES.OPEN, {
        reason: 'half-open-failure',
        error: err?.message,
      });
      return;
    }

    if (this.state === STATES.CLOSED) {
      this.failures.push(this._now());
      this._pruneFailures();
      this.failureCount = this.failures.length;

      if (this.failureCount >= this.failureThreshold) {
        this._transitionTo(STATES.OPEN, {
          reason: 'failure-threshold',
          error: err?.message,
        });
      }
    }
  }

  reset() {
    this._transitionTo(STATES.CLOSED, { reason: 'manual-reset' });
  }

  _moveToHalfOpenIfReady() {
    if (this.state !== STATES.OPEN || this.openedAt === null) {
      return;
    }

    if (this._now() - this.openedAt >= this.timeoutMs) {
      this._transitionTo(STATES.HALF_OPEN, { reason: 'cooldown-elapsed' });
    }
  }

  _transitionTo(nextState, metadata = {}) {
    if (this.state === nextState) {
      return;
    }

    const previousState = this.state;
    const previousFailureCount = this.failureCount;
    const previousSuccessCount = this.successCount;
    this.state = nextState;
    this.failureCount = 0;
    this.failures = [];
    this.successCount = 0;
    this.openedAt = nextState === STATES.OPEN ? this._now() : null;

    this._logger.info('Circuit breaker state changed', {
      source: this.name,
      client: this.name,
      from: previousState,
      to: nextState,
      failure_count: previousFailureCount,
      success_count: previousSuccessCount,
      ...metadata,
    });
  }
}

module.exports = {
  CircuitBreaker,
  CircuitBreakerOpenError,
  STATES,
  isDependencyFailure,
  registerBreaker,
  getBreaker,
  getAllBreakers,
  getAllBreakerStates,
  clearRegistry,
};
