'use strict';

/**
 * Redis-based distributed lock (lease) for leader election.
 *
 * Implements a single-key lease using SET NX PX for acquisition and a Lua
 * script for atomic check-and-renew, following the same Lua-atomic pattern
 * used elsewhere in this codebase (see deliveryRepository.js).
 *
 * Lock keys follow the convention `leader:<job_name>` so each background
 * job type can have its own independent leader.
 *
 * Failover window:
 *   If the leader process dies without releasing its lease, the lease will
 *   expire automatically after LEASE_TTL_MS milliseconds. A follower will
 *   detect the expired lease on its next renewal check (renewal interval)
 *   and attempt to acquire leadership. The maximum failover time is bounded
 *   by LEASE_TTL_MS + LEASE_RENEW_INTERVAL_MS (with jitter).
 *
 *   Example with defaults (LEASE_TTL_MS=15000, LEASE_RENEW_INTERVAL_MS=5000):
 *     Worst-case failover: ~20s (15s TTL + 5s check interval)
 *     Typical failover:    ~7-15s (TTL expires; next check detects it)
 */

const crypto = require('crypto');
const os = require('os');
const cache = require('./cache');
const logger = require('../logger');
const config = require('../config');

// Lua script: atomically renew a lease only if we still hold it.
// KEYS[1] — lock key (e.g. "leader:price_refresh")
// ARGV[1] — expected instance id (our id)
// ARGV[2] — new TTL in milliseconds
// Returns 1 if renewed, 0 if we no longer hold the lease.
const RENEW_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

// Lua script: atomically release a lease only if we still hold it.
// KEYS[1] — lock key
// ARGV[1] — expected instance id
// Returns 1 if released, 0 if we didn't hold it.
const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

let ensureCommandsRegistered = false;

function registerLuaCommands(redis) {
  if (ensureCommandsRegistered) return;
  redis.defineCommand('renewLease', { numberOfKeys: 1, lua: RENEW_LUA });
  redis.defineCommand('releaseLease', { numberOfKeys: 1, lua: RELEASE_LUA });
  ensureCommandsRegistered = true;
}

/**
 * Creates a leader-election instance for a named job.
 *
 * @param {string} jobName - Logical job name (e.g. "price_refresh", "webhook_retry", "airdrop_expiry")
 * @param {object} [opts] - Optional overrides
 * @param {number} [opts.leaseTtlMs] - Lease TTL in milliseconds (default: config.leaderElection.leaseTtlMs)
 * @param {number} [opts.renewIntervalMs] - How often to attempt renewal (default: config.leaderElection.renewIntervalMs)
 * @param {string} [opts.instanceId] - This instance's identifier (default: config.leaderElection.instanceId)
 * @returns {object} Leader election interface
 */
function createLeaderElection(jobName, opts = {}) {
  const lockKey = `leader:${jobName}`;
  const instanceId = opts.instanceId || config.leaderElection.instanceId;
  const leaseTtlMs = opts.leaseTtlMs || config.leaderElection.leaseTtlMs;
  const renewIntervalMs = opts.renewIntervalMs || config.leaderElection.renewIntervalMs;

  let leader = false;
  let renewTimer = null;
  let acquiredAt = null;
  let lastRenewedAt = null;
  let stateChangeHandler = null;

  function notifyStateChange() {
    if (typeof stateChangeHandler !== 'function') return;

    try {
      stateChangeHandler();
    } catch (err) {
      logger.error('Leader state-change callback failed', {
        job: jobName,
        instanceId,
        error: err.message,
      });
    }
  }

  /**
   * Attempt to acquire the leader lease.
   * Returns true if acquired, false if someone else holds it.
   */
  async function tryAcquire() {
    const redis = cache.getClient();
    registerLuaCommands(redis);

    const result = await redis.set(lockKey, instanceId, 'NX', 'PX', leaseTtlMs);
    if (result === 'OK') {
      if (!leader) {
        logger.info('Acquired leader lease', { job: jobName, instanceId, lockKey, leaseTtlMs });
      }
      leader = true;
      acquiredAt = Date.now();
      lastRenewedAt = Date.now();
      notifyStateChange();
      return true;
    }

    if (leader) {
      // We thought we were leader but can't acquire — someone else has it.
      // This shouldn't normally happen with proper renewal, but handles edge
      // cases like a long GC pause causing lease expiry.
      logger.warn('Lost leader lease — another instance has acquired it', {
        job: jobName,
        instanceId,
        lockKey,
      });
      leader = false;
      acquiredAt = null;
      lastRenewedAt = null;
      notifyStateChange();
    }

    return false;
  }

  /**
   * Attempt to renew the lease. Returns true if renewal succeeded (we still
   * hold the lease), false if we lost it.
   */
  async function renew() {
    if (!leader) return false;

    const redis = cache.getClient();
    registerLuaCommands(redis);

    try {
      const result = await redis.renewLease(lockKey, instanceId, leaseTtlMs);
      if (result === 1) {
        lastRenewedAt = Date.now();
        return true;
      }

      // Lease expired and someone else took it, or it was manually deleted.
      logger.warn('Failed to renew leader lease — lost leadership', {
        job: jobName,
        instanceId,
        lockKey,
      });
      leader = false;
      acquiredAt = null;
      lastRenewedAt = null;
      notifyStateChange();
      return false;
    } catch (err) {
      logger.error('Leader lease renewal error', {
        job: jobName,
        instanceId,
        lockKey,
        error: err.message,
      });
      // Don't clear leader flag on transient Redis errors — the lease may
      // still be valid. We'll retry on the next renewal cycle.
      return leader;
    }
  }

  /**
   * Release the lease explicitly. Called during graceful shutdown.
   */
  async function release() {
    if (!leader) return;

    const redis = cache.getClient();
    registerLuaCommands(redis);

    try {
      await redis.releaseLease(lockKey, instanceId);
      logger.info('Released leader lease', { job: jobName, instanceId, lockKey });
    } catch (err) {
      logger.error('Error releasing leader lease', {
        job: jobName,
        instanceId,
        lockKey,
        error: err.message,
      });
    }

    leader = false;
    acquiredAt = null;
    lastRenewedAt = null;
    notifyStateChange();
  }

  /**
   * Start the periodic renewal loop.
   */
  function startRenewLoop(onStateChange) {
    if (typeof onStateChange === 'function') stateChangeHandler = onStateChange;
    if (renewTimer) return;

    // Try to acquire immediately on start
    tryAcquire().catch((err) => {
      logger.error('Leader election initial acquire failed', {
        job: jobName,
        instanceId,
        error: err.message,
      });
    });

    renewTimer = setInterval(() => {
      if (leader) {
        // We hold the lease — try to renew it
        renew().catch((err) => {
          logger.error('Leader election renewal loop error', {
            job: jobName,
            instanceId,
            error: err.message,
          });
        });
      } else {
        // We don't hold the lease — try to acquire
        tryAcquire().catch((err) => {
          logger.error('Leader election acquire retry failed', {
            job: jobName,
            instanceId,
            error: err.message,
          });
        });
      }
    }, renewIntervalMs);

    if (typeof renewTimer.unref === 'function') {
      renewTimer.unref();
    }

    logger.info('Leader election renewal loop started', {
      job: jobName,
      instanceId,
      lockKey,
      renewIntervalMs,
      leaseTtlMs,
    });
  }

  /**
   * Stop the periodic renewal loop and release the lease.
   */
  async function stopRenewLoop() {
    if (renewTimer) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
    await release();
    stateChangeHandler = null;
    logger.info('Leader election renewal loop stopped', { job: jobName, instanceId });
  }

  /**
   * Returns whether this instance currently holds the leader lease.
   */
  function isLeader() {
    return leader;
  }

  /**
   * Returns diagnostic info about the current leadership state.
   */
  function getState() {
    return {
      isLeader: leader,
      instanceId,
      lockKey,
      leaseTtlMs,
      renewIntervalMs,
      acquiredAt: acquiredAt ? new Date(acquiredAt).toISOString() : null,
      lastRenewedAt: lastRenewedAt ? new Date(lastRenewedAt).toISOString() : null,
    };
  }

  /**
   * Fetch the current lease holder from Redis (external view).
   */
  async function getCurrentLeader() {
    try {
      const redis = cache.getClient();
      return await redis.get(lockKey);
    } catch (err) {
      logger.error('Error fetching current leader', {
        job: jobName,
        lockKey,
        error: err.message,
      });
      return null;
    }
  }

  return {
    tryAcquire,
    renew,
    release,
    startRenewLoop,
    stopRenewLoop,
    isLeader,
    getState,
    getCurrentLeader,
    jobName,
    lockKey,
    instanceId,
  };
}

module.exports = { createLeaderElection };

