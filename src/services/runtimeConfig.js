'use strict';

const EventEmitter = require('events');
const logger = require('../logger');
const cache = require('./cache');
const baseConfig = require('../config');

class RuntimeConfigService extends EventEmitter {
  constructor() {
    super();
    this._redisKey = 'config:runtime';
    this._pollIntervalMs = 10000;
    this._timer = null;
    this._state = {};
    this._initialized = false;
  }

  /**
   * Validate runtime dynamic config changes.
   * Only allows non-critical keys (e.g., rate limits, thresholds, feature flags).
   */
  validate(updates) {
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      throw new Error('Config updates must be a non-empty object');
    }

    const validated = {};

    for (const [key, value] of Object.entries(updates)) {
      switch (key) {
        case 'RATE_LIMIT_MAX':
        case 'rateLimitMax': {
          const num = Number(value);
          if (!Number.isSafeInteger(num) || num <= 0) {
            throw new Error('rateLimitMax must be a positive integer');
          }
          validated.rateLimitMax = num;
          break;
        }
        case 'RATE_LIMIT_WINDOW_MS':
        case 'rateLimitWindowMs': {
          const num = Number(value);
          if (!Number.isSafeInteger(num) || num <= 0) {
            throw new Error('rateLimitWindowMs must be a positive integer');
          }
          validated.rateLimitWindowMs = num;
          break;
        }
        case 'PRICE_RATELIMIT_MAX':
        case 'priceRateLimitMax': {
          const num = Number(value);
          if (!Number.isSafeInteger(num) || num <= 0) {
            throw new Error('priceRateLimitMax must be a positive integer');
          }
          validated.priceRateLimitMax = num;
          break;
        }
        case 'PRICE_RATELIMIT_WINDOW':
        case 'priceRateLimitWindow': {
          const num = Number(value);
          if (!Number.isSafeInteger(num) || num <= 0) {
            throw new Error('priceRateLimitWindow must be a positive integer');
          }
          validated.priceRateLimitWindow = num;
          break;
        }
        case 'SLOW_REQUEST_THRESHOLD_MS':
        case 'slowRequestThresholdMs': {
          const num = Number(value);
          if (isNaN(num) || num <= 0) {
            throw new Error('slowRequestThresholdMs must be a positive number');
          }
          validated.slowRequestThresholdMs = num;
          break;
        }
        case 'PRICE_ANOMALY_THRESHOLD_PCT':
        case 'priceAnomalyThresholdPct': {
          const num = Number(value);
          if (isNaN(num) || num <= 0) {
            throw new Error('priceAnomalyThresholdPct must be a positive number');
          }
          validated.priceAnomalyThresholdPct = num;
          break;
        }
        case 'PRICE_ANOMALY_ACTION':
        case 'priceAnomalyAction': {
          if (value !== 'warn' && value !== 'reject') {
            throw new Error('priceAnomalyAction must be either "warn" or "reject"');
          }
          validated.priceAnomalyAction = value;
          break;
        }
        case 'FEATURE_FLAGS':
        case 'featureFlags': {
          if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new Error('featureFlags must be an object');
          }
          validated.featureFlags = { ...value };
          break;
        }
        default:
          throw new Error(`Unsupported or cold-reload config key: ${key}`);
      }
    }

    return validated;
  }

  /**
   * Apply validated config changes, update local state and notify subscribers.
   */
  applyChanges(newValues, source = 'manual') {
    const validated = this.validate(newValues);
    const changes = {};

    for (const [key, val] of Object.entries(validated)) {
      const oldVal = this._state[key] !== undefined ? this._state[key] : this._getDefault(key);
      if (JSON.stringify(oldVal) !== JSON.stringify(val)) {
        changes[key] = { oldValue: oldVal, newValue: val };
        this._state[key] = val;
      }
    }

    if (Object.keys(changes).length > 0) {
      logger.info('Runtime configuration updated', {
        source,
        changes,
      });

      // Emit specific key changes and aggregate change event
      for (const [key, change] of Object.entries(changes)) {
        this.emit(`change:${key}`, change.newValue, change.oldValue);
      }
      this.emit('change', this.getAll(), changes);
    }

    return { updated: Object.keys(changes).length > 0, changes };
  }

  _getDefault(key) {
    switch (key) {
      case 'rateLimitMax':
        return baseConfig.rateLimit.max;
      case 'rateLimitWindowMs':
        return baseConfig.rateLimit.windowMs;
      case 'priceRateLimitMax':
        return baseConfig.priceRateLimit.max;
      case 'priceRateLimitWindow':
        return baseConfig.priceRateLimit.windowSeconds;
      case 'slowRequestThresholdMs':
        return baseConfig.slowRequestThresholdMs;
      case 'priceAnomalyThresholdPct':
        return baseConfig.price.anomalyThresholdPercent;
      case 'priceAnomalyAction':
        return baseConfig.price.anomalyAction;
      case 'featureFlags':
        return {};
      default:
        return undefined;
    }
  }

  get(key) {
    if (this._state[key] !== undefined) {
      return this._state[key];
    }
    return this._getDefault(key);
  }

  getAll() {
    return {
      rateLimitMax: this.get('rateLimitMax'),
      rateLimitWindowMs: this.get('rateLimitWindowMs'),
      priceRateLimitMax: this.get('priceRateLimitMax'),
      priceRateLimitWindow: this.get('priceRateLimitWindow'),
      slowRequestThresholdMs: this.get('slowRequestThresholdMs'),
      priceAnomalyThresholdPct: this.get('priceAnomalyThresholdPct'),
      priceAnomalyAction: this.get('priceAnomalyAction'),
      featureFlags: this.get('featureFlags'),
    };
  }

  /**
   * Reset runtime overrides (useful for testing).
   */
  reset() {
    this._state = {};
  }

  /**
   * Periodically check Redis for config updates.
   */
  async syncFromRedis() {
    try {
      const client = cache.getClient();
      if (!client || client.status !== 'ready') return;

      const raw = await client.get(this._redisKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.applyChanges(parsed, 'redis');
      }
    } catch (err) {
      logger.warn('Failed to sync runtime config from Redis', { error: err.message });
    }
  }

  startWatcher(intervalMs = this._pollIntervalMs) {
    if (this._timer) return;
    this._pollIntervalMs = intervalMs;
    this.syncFromRedis();
    this._timer = setInterval(() => {
      this.syncFromRedis();
    }, this._pollIntervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stopWatcher() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

const runtimeConfig = new RuntimeConfigService();

module.exports = runtimeConfig;
