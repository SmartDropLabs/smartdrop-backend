'use strict';

/**
 * Feature flag evaluation service (#517).
 *
 * Enables gradual rollouts, A/B experiments, and instant kill-switches
 * without redeployment. Supports boolean toggles, environment variable
 * overrides (`FEATURE_FLAG_<NAME>`), user/context allowlists & blocklists,
 * and deterministic percentage rollouts via SHA-256 bucketing.
 */

const crypto = require('crypto');

class FeatureFlagService {
  constructor(initialFlags = {}, options = {}) {
    this.env = options.env || process.env;
    this.flags = new Map();

    for (const [name, config] of Object.entries(initialFlags)) {
      this.defineFlag(name, config);
    }
  }

  /**
   * Defines or updates a feature flag configuration at runtime.
   *
   * @param {string} name Flag identifier (e.g. 'batch_airdrop_v2')
   * @param {boolean|Object} config Boolean or { enabled, rolloutPercentage, allowlist, blocklist, description }
   */
  defineFlag(name, config = {}) {
    if (!name || typeof name !== 'string') {
      throw new Error('Feature flag name must be a non-empty string');
    }

    const normalized =
      typeof config === 'boolean'
        ? {
            enabled: config,
            rolloutPercentage: config ? 100 : 0,
            allowlist: new Set(),
            blocklist: new Set(),
            description: '',
          }
        : {
            enabled: Boolean(config.enabled),
            rolloutPercentage:
              typeof config.rolloutPercentage === 'number'
                ? Math.max(0, Math.min(100, config.rolloutPercentage))
                : config.enabled
                  ? 100
                  : 0,
            allowlist: new Set(Array.isArray(config.allowlist) ? config.allowlist : []),
            blocklist: new Set(Array.isArray(config.blocklist) ? config.blocklist : []),
            description: config.description || '',
          };

    this.flags.set(name, normalized);
    return this.getFlag(name);
  }

  /**
   * Evaluates whether a feature flag is enabled for the given context.
   *
   * Precedence:
   * 1. Environment variable override (`FEATURE_FLAG_<UPPER_SNAKE_NAME>`)
   * 2. Explicit blocklist match (`context.userId` or `context.key`)
   * 3. Explicit allowlist match (`context.userId` or `context.key`)
   * 4. Master `enabled` boolean + deterministic percentage rollout
   *
   * @param {string} name Flag identifier
   * @param {Object} [context={}] Optional evaluation context `{ userId, key }`
   * @returns {boolean}
   */
  isEnabled(name, context = {}) {
    const envOverride = this._readEnvOverride(name);
    if (envOverride !== null) {
      return envOverride;
    }

    const flag = this.flags.get(name);
    if (!flag) {
      return false;
    }

    const subjectKey = context.userId || context.key || null;

    if (subjectKey && flag.blocklist.has(String(subjectKey))) {
      return false;
    }

    if (subjectKey && flag.allowlist.has(String(subjectKey))) {
      return true;
    }

    if (!flag.enabled) {
      return false;
    }

    if (flag.rolloutPercentage >= 100) {
      return true;
    }

    if (flag.rolloutPercentage <= 0) {
      return false;
    }

    if (!subjectKey) {
      return false;
    }

    const bucket = FeatureFlagService.computeBucket(name, String(subjectKey));
    return bucket < flag.rolloutPercentage;
  }

  /**
   * Computes a deterministic integer bucket in [0, 99] for `(flagName, subjectKey)`.
   */
  static computeBucket(flagName, subjectKey) {
    const digest = crypto
      .createHash('sha256')
      .update(`${flagName}:${subjectKey}`)
      .digest();
    const intVal = digest.readUInt32BE(0);
    return intVal % 100;
  }

  /**
   * Express middleware factory that gates a route behind a feature flag.
   */
  requireFlag(name, options = {}) {
    const statusCode = options.statusCode || 404;
    const message = options.message || `Feature '${name}' is not enabled`;

    return (req, res, next) => {
      const context = {
        userId: req?.user?.id || req?.headers?.['x-user-id'] || req?.ip,
      };
      if (this.isEnabled(name, context)) {
        return next();
      }
      return res.status(statusCode).json({ error: message, flag: name });
    };
  }

  getFlag(name) {
    const flag = this.flags.get(name);
    if (!flag) return null;
    return {
      name,
      enabled: flag.enabled,
      rolloutPercentage: flag.rolloutPercentage,
      allowlist: Array.from(flag.allowlist),
      blocklist: Array.from(flag.blocklist),
      description: flag.description,
    };
  }

  listFlags() {
    const result = [];
    for (const name of this.flags.keys()) {
      result.push(this.getFlag(name));
    }
    return result;
  }

  _readEnvOverride(name) {
    const envKey = `FEATURE_FLAG_${name.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`;
    const raw = this.env?.[envKey];
    if (raw === undefined || raw === '') return null;
    const normalized = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return null;
  }
}

const defaultFeatureFlags = new FeatureFlagService();

module.exports = {
  FeatureFlagService,
  featureFlags: defaultFeatureFlags,
};
