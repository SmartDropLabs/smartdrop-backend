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
 *
 * Usage analytics (#691):
 *   evaluateFlag(name, userId) behaves like isEnabled(name, { userId }) and
 *   additionally records per-flag evaluation counts via trackUsage(). Tracking
 *   is best-effort: any failure is logged and never changes the returned result.
 *   Counters are in-process only (no storage), so no migration is required.
 */

const cache = require('./cache');
const logger = require('../logger');

// In-memory flag store. In production, back this with Redis or a DB.
const flags = new Map();

// In-memory usage counters (#691). Keyed by flag name.
// Per-user IDs are intentionally not retained.
const usageStats = new Map();

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
 * Set or update a feature flag, invalidating cache (#625).
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
  // Fire-and-forget cache invalidation
  try {
    cache.del(`flag:${name}`).catch?.(() => {});
    cache.del('flags:all').catch?.(() => {});
  } catch {
    // Ignore cache errors
  }
}

/**
 * Update a feature flag and invalidate cache (#625).
 * @param {string} name - Flag name
 * @param {Object|boolean} value - Flag configuration or boolean
 */
async function updateFlag(name, value) {
  const config = typeof value === 'boolean' ? { enabled: value } : (value || {});
  setFlag(name, config);
  try {
    await cache.del(`flag:${name}`);
    await cache.del('flags:all');
  } catch (err) {
    logger.warn(`Failed to invalidate cache for flag:${name}`, { error: err.message });
  }
}

/**
 * Remove a feature flag and invalidate cache (#625).
 * @param {string} name - Flag name
 */
async function removeFlag(name) {
  flags.delete(name);
  try {
    await cache.del(`flag:${name}`);
    await cache.del('flags:all');
  } catch (err) {
    logger.warn(`Failed to invalidate cache for flag:${name}`, { error: err.message });
  }
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
 * Evaluate a flag for a user and record the outcome (#691).
 * Returns exactly what isEnabled(name, { userId }) returns. Tracking failures
 * are caught inside trackUsage and never affect the result.
 * @param {string} name - Flag name
 * @param {string} [userId] - User ID used for allow/deny lists and rollout bucketing
 * @returns {boolean}
 */
function evaluateFlag(name, userId) {
  const enabled = isEnabled(name, userId ? { userId } : {});
  trackUsage(name, userId, enabled);
  return enabled;
}

/**
 * Record one flag evaluation in the in-memory usage counters (#691).
 * Never throws: failures are logged at warn level and swallowed.
 * @param {string} name - Flag name
 * @param {string} [userId] - Evaluated user ID (not stored, to limit retained personal data)
 * @param {boolean} enabled - Result of the evaluation
 */
function trackUsage(name, userId, enabled) {
  void userId;
  try {
    const key = String(name);
    let entry = usageStats.get(key);
    if (!entry) {
      entry = { evaluations: 0, enabled: 0, disabled: 0, lastEvaluatedAt: null };
      usageStats.set(key, entry);
    }
    entry.evaluations += 1;
    if (enabled) {
      entry.enabled += 1;
    } else {
      entry.disabled += 1;
    }
    entry.lastEvaluatedAt = Date.now();
  } catch (err) {
    try {
      logger.warn(`Feature flag usage tracking failed for ${name}`, { error: err.message });
    } catch {
      // Logging must never break flag evaluation either
    }
  }
}

/**
 * Get usage counters (#691).
 * @param {string} [name] - Optional flag name. Omit to get all flags.
 * @returns {Object|null} Copy of the counters for one flag (null if never evaluated),
 *   or an object keyed by flag name when no name is given.
 */
function getUsageStats(name) {
  if (name !== undefined) {
    const entry = usageStats.get(String(name));
    return entry ? { ...entry } : null;
  }
  const result = {};
  for (const [key, entry] of usageStats) {
    result[key] = { ...entry };
  }
  return result;
}

/**
 * Clear all usage counters (#691). Primarily useful in tests.
 */
function resetUsageStats() {
  usageStats.clear();
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
  updateFlag,
  removeFlag,
  isEnabled,
  getAllFlags,
  evaluateFlag,
  trackUsage,
  getUsageStats,
  resetUsageStats,
};
