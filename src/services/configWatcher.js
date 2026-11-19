'use strict';

/**
 * Runtime configuration hot-reload service (#256).
 *
 * Periodically checks a Redis key for configuration changes and notifies
 * subscribers when non-critical config values change. Startup-critical
 * config (DB, Redis, Stellar RPC) remains cold-reload only.
 *
 * Usage:
 *   const configWatcher = require('../services/configWatcher');
 *   configWatcher.start();
 *   configWatcher.on('configChanged', ({ key, oldValue, newValue }) => { ... });
 */

const EventEmitter = require('events');
const logger = require('../logger');
const cache = require('./cache');

const CONFIG_KEY = 'smartdrop:runtime_config';
const DEFAULT_POLL_INTERVAL_MS = 30_000;

// Config keys that can be hot-reloaded at runtime
const HOT_RELOAD_KEYS = [
  'webhooks.maxAttempts',
  'webhooks.retryBaseMs',
  'webhooks.retryFactor',
  'webhooks.timeoutMs',
  'webhooks.retryPollMs',
  'webhooks.retryBatchSize',
  'webhooks.rateLimit.windowSeconds',
  'webhooks.rateLimit.max',
  'price.cacheTtl',
  'price.refreshInterval',
  'price.anomalyThresholdPercent',
  'price.minSources',
  'airdrops.rateLimit.windowSeconds',
  'airdrops.rateLimit.max',
  'rateLimit.windowMs',
  'rateLimit.max',
  'slowRequestThresholdMs',
];

class ConfigWatcher extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
    this.timer = null;
    this.running = false;
    this.lastConfig = null;
    this.logger = options.logger || logger;
  }

  start() {
    if (this.timer) return;
    this.running = true;

    const poll = async () => {
      try {
        await this.checkForChanges();
      } catch (err) {
        this.logger.error('Config watcher poll failed', { error: err.message });
      }
    };

    // Initial check
    poll();

    this.timer = setInterval(poll, this.pollIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.logger.info('Config watcher started', { intervalMs: this.pollIntervalMs });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.running = false;
      this.logger.info('Config watcher stopped');
    }
  }

  async checkForChanges() {
    const redis = cache.getClient();
    const raw = await redis.get(CONFIG_KEY);
    if (!raw) return;

    let currentConfig;
    try {
      currentConfig = JSON.parse(raw);
    } catch (err) {
      this.logger.warn('Failed to parse runtime config from Redis', { error: err.message });
      return;
    }

    if (!this.lastConfig) {
      this.lastConfig = currentConfig;
      return;
    }

    // Compare configs and emit events for changes
    for (const key of HOT_RELOAD_KEYS) {
      const oldValue = this.getNestedValue(this.lastConfig, key);
      const newValue = this.getNestedValue(currentConfig, key);

      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        this.logger.info('Runtime config changed', { key, oldValue, newValue });
        this.emit('configChanged', { key, oldValue, newValue });
      }
    }

    this.lastConfig = currentConfig;
  }

  getNestedValue(obj, path) {
    return path.split('.').reduce((acc, part) => acc?.[part], obj);
  }

  /**
   * Update a runtime config value in Redis.
   *
   * @param {string} key - Config key (e.g. 'webhooks.maxAttempts')
   * @param {*} value - New value
   * @returns {Promise<boolean>} Whether the update was valid
   */
  async updateConfig(key, value) {
    if (!HOT_RELOAD_KEYS.includes(key)) {
      this.logger.warn('Attempted to update non-hot-reloadable config', { key });
      return false;
    }

    const redis = cache.getClient();
    const raw = await redis.get(CONFIG_KEY);
    const config = raw ? JSON.parse(raw) : {};

    this.setNestedValue(config, key, value);
    await redis.set(CONFIG_KEY, JSON.stringify(config));

    this.logger.info('Runtime config updated via API', { key, value });
    this.emit('configUpdated', { key, value });

    return true;
  }

  setNestedValue(obj, path, value) {
    const parts = path.split('.');
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]]) current[parts[i]] = {};
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
  }

  /**
   * Get the list of hot-reloadable config keys.
   */
  getHotReloadKeys() {
    return [...HOT_RELOAD_KEYS];
  }
}

module.exports = { ConfigWatcher };
