'use strict';

const cache = require('../services/cache');
const { getDb } = require('../database');
const config = require('../config');
const logger = require('../logger');

const DEFAULT_DEPENDENCY_TIMEOUT_MS = 2000;

/**
 * Execute a check with a strict timeout to ensure hanging dependencies
 * cannot hang the health endpoint (#455).
 */
async function withTimeout(promise, timeoutMs) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('TIMEOUT');
      err.isTimeout = true;
      reject(err);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check database connectivity and measure latency.
 */
async function checkDatabaseDependency(timeoutMs = DEFAULT_DEPENDENCY_TIMEOUT_MS) {
  const start = Date.now();
  try {
    const db = getDb();
    await withTimeout(db.raw('SELECT 1'), timeoutMs);
    const latencyMs = Date.now() - start;
    return { status: 'ok', latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const isTimeout = err.isTimeout || err.message === 'TIMEOUT';
    return {
      status: isTimeout ? 'timeout' : 'error',
      latencyMs: isTimeout ? timeoutMs : latencyMs,
    };
  }
}

/**
 * Check Redis connectivity and measure latency.
 */
async function checkRedisDependency(timeoutMs = DEFAULT_DEPENDENCY_TIMEOUT_MS) {
  const start = Date.now();
  try {
    if (!cache.isConnected || !cache.isConnected()) {
      return { status: 'error', latencyMs: 0 };
    }
    const client = cache.getClient();
    if (!client || typeof client.ping !== 'function') {
      return { status: 'error', latencyMs: 0 };
    }
    await withTimeout(client.ping(), timeoutMs);
    const latencyMs = Date.now() - start;
    return { status: 'ok', latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const isTimeout = err.isTimeout || err.message === 'TIMEOUT';
    return {
      status: isTimeout ? 'timeout' : 'error',
      latencyMs: isTimeout ? timeoutMs : latencyMs,
    };
  }
}

/**
 * Check health of background jobs.
 *
 * @param {Object} jobs - Map of job name to job instance with getHealth()
 * @returns {{ jobHealth: Object, allHealthy: boolean }}
 */
function checkJobHealth(jobs = {}) {
  const jobHealth = {};
  let allHealthy = true;

  for (const [name, job] of Object.entries(jobs)) {
    if (typeof job?.getHealth === 'function') {
      try {
        const health = job.getHealth();
        jobHealth[name] = health;
        if (!health.healthy) {
          allHealthy = false;
        }
      } catch (err) {
        jobHealth[name] = { healthy: false, error: err.message };
        allHealthy = false;
      }
    }
  }

  return { jobHealth, allHealthy };
}

/**
 * Lightweight liveness check: returns 200 without touching dependencies.
 */
function checkLiveness() {
  return { status: 'ok' };
}

/**
 * Readiness check: verifies all real dependencies the app uses, with timeouts.
 * Never exposes credentials, connection strings, or internal traces.
 *
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=2000]
 * @param {Function} [options.dbCheck]
 * @param {Function} [options.redisCheck]
 * @returns {Promise<{ status: string, dependencies: Object }>}
 */
async function checkReadiness(options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_DEPENDENCY_TIMEOUT_MS;

  const dbPromise = options.dbCheck
    ? options.dbCheck(timeoutMs)
    : checkDatabaseDependency(timeoutMs);

  const redisPromise = options.redisCheck
    ? options.redisCheck(timeoutMs)
    : checkRedisDependency(timeoutMs);

  const [dbResult, redisResult] = await Promise.all([dbPromise, redisPromise]);

  const dependencies = {
    database: dbResult,
    redis: redisResult,
  };

  const isHealthy =
    dbResult.status === 'ok' && redisResult.status === 'ok';

  return {
    status: isHealthy ? 'ok' : 'unhealthy',
    dependencies,
  };
}

module.exports = {
  checkDatabaseDependency,
  checkJobHealth,
  checkLiveness,
  checkReadiness,
  checkRedisDependency,
  withTimeout,
  DEFAULT_DEPENDENCY_TIMEOUT_MS,
};
