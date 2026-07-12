'use strict';

const logger = require('../logger');

const STATES = Object.freeze({
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half-open',
});

class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = name;
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 3);
    this.successThreshold = Math.max(1, options.successThreshold ?? 1);
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 30000);
    this._now = options.now || Date.now;
    this._logger = options.logger || logger;

    this.state = STATES.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.openedAt = null;
    this.halfOpenInFlight = false;
  }

  getState() {
    this._moveToHalfOpenIfReady();
    return this.state;
  }

  isOpen() {
    return this.getState() === STATES.OPEN;
  }

  async call(fn) {
    this._moveToHalfOpenIfReady();

    if (this.state === STATES.OPEN) {
      this._logger.info('Circuit breaker open, skipping source call', {
        source: this.name,
        state: this.state,
      });
      return null;
    }

    if (this.state === STATES.HALF_OPEN && this.halfOpenInFlight) {
      this._logger.info('Circuit breaker half-open probe already in flight, skipping source call', {
        source: this.name,
        state: this.state,
      });
      return null;
    }

    const probing = this.state === STATES.HALF_OPEN;
    if (probing) {
      this.halfOpenInFlight = true;
    }

    try {
      const result = await fn();
      if (result === null || result === undefined) {
        this.recordFailure();
      } else {
        this.recordSuccess();
      }
      return result ?? null;
    } catch (err) {
      this.recordFailure();
      throw err;
    } finally {
      if (probing) {
        this.halfOpenInFlight = false;
      }
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
    }
  }

  recordFailure() {
    if (this.state === STATES.HALF_OPEN) {
      this._transitionTo(STATES.OPEN, { reason: 'half-open-failure' });
      return;
    }

    if (this.state === STATES.CLOSED) {
      this.failureCount += 1;
      if (this.failureCount >= this.failureThreshold) {
        this._transitionTo(STATES.OPEN, { reason: 'failure-threshold' });
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
    this.state = nextState;
    this.failureCount = 0;
    this.successCount = 0;
    this.openedAt = nextState === STATES.OPEN ? this._now() : null;

    this._logger.info('Circuit breaker state changed', {
      source: this.name,
      from: previousState,
      to: nextState,
      ...metadata,
    });
  }
}

module.exports = {
  CircuitBreaker,
  STATES,
};
