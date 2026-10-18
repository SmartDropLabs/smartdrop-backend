'use strict';

/**
 * Feature flag service (#517).
 *
 * Simple feature flag system supporting boolean flags, percentage rollouts,
 * and user allowlists. Flags are stored in memory and can be updated at runtime
 * via the admin API or environment variables.
 *
 * Usage:
 *   const featureFlags = require('./featureFlags');
 *   if (featureFlags.isEnabled('new-checkout', { userId })) {
 *     // new checkout flow
 *   }
 */

const logger = require('../logger');

// In-memory flag store. In production, back this with Redis or a DB.
const flags = new Map();

/**
 * Flag structure:
 * {
 *   enabled: boolean,          — master toggle
 *   percentage: number,        — 0-100, percentage of users who see the flag
 *   allowlist: string[],       — always-enabled user IDs
 *   denylist: string[],        — always-disabled user IDs
 * }
 */

/**
 * Initialize flags from environment variables.
 * Format: FEATURE_FLAG_<NAME>=true|false|percentage:50
 */
function initFromEnv() {
  const prefix = 'FEATURE_FLAG_';
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(prefix)) continue;
    const name = key.slice(prefix.length).toLowerCase().replace(/_/g, '-');
    if (value === 'true' || value === 'false') {
      setFlag(name, { enabled: value === 'true' });
    } else if (value.startsWith('percentage:')) {
      setFlag(name, { enabled: true, percentage: parseInt(value.slice(11), 10) });
    }
    logger.info(`Feature flag initialized from env: ${name} = ${value}`);
  }
}

/**
 * Set or update a feature flag.
 * @param {string} name - Flag name
 * @param {Object} config - Flag configuration
 */
function setFlag(name, config) {
  flags.set(name, {
    enabled: config.enabled ?? true,
    percentage: config.percentage ?? 100,
    allowlist: config.allowlist ?? [],
    denylist: config.denylist ?? [],
    updatedAt: Date.now(),
  });
}

/**
 * Check if a feature is enabled for a given context.
 * @param {string} name - Flag name
 * @param {Object} [context] - { userId: string }
 * @returns {boolean}
 */
function isEnabled(name, context = {}) {
  const flag = flags.get(name);
  if (!flag) return false;
  if (!flag.enabled) return false;

  const { userId } = context;

  // Denylist takes precedence
  if (userId && flag.denylist.includes(userId)) return false;

  // Allowlist always enabled
  if (userId && flag.allowlist.includes(userId)) return true;

  // Percentage rollout: deterministic hash so the same user always gets
  // the same result within a flag's lifetime.
  if (flag.percentage < 100) {
    if (!userId) return false;
    const hash = hashCode(`${name}:${userId}`);
    const bucket = (Math.abs(hash) % 100) + 1;
    return bucket <= flag.percentage;
  }

  return true;
}

/**
 * Get all flags (for admin display).
 */
function getAllFlags() {
  return Object.fromEntries(flags);
}

/**
 * Simple string hash for consistent percentage bucketing.
 */
function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash;
}

module.exports = {
  initFromEnv,
  setFlag,
  isEnabled,
  getAllFlags,
};
