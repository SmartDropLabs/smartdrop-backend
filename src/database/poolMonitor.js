"use strict";

/**
 * Database Connection Pool Monitoring (#520, #721).
 *
 * Provides real-time metrics, event tracking, utilization analysis,
 * connection timeout detection, and Prometheus formatting for the Knex (Tarn.js)
 * database connection pool.
 */

const logger = require("../logger");

const DEFAULT_CONNECTION_TIMEOUT = 30000; // 30 seconds connection timeout (#721)

/**
 * Detect if a connection has timed out and destroy it if so (#721).
 *
 * @param {Object} connection - Connection object
 * @param {number} [timeout=30000] - Timeout in milliseconds
 * @returns {boolean} True if timed out and destroyed
 */
function checkConnectionTimeout(connection, timeout = DEFAULT_CONNECTION_TIMEOUT) {
  if (!connection) return false;
  const start = connection.start || connection.acquiredAt || Date.now();
  if (Date.now() - start > timeout) {
    if (typeof connection.destroy === "function") {
      connection.destroy();
    }
    return true;
  }
  return false;
}

class PoolMonitor {
  constructor(options = {}) {
    this.warningThreshold = options.warningThreshold ?? 0.8; // 80% utilization
    this.criticalThreshold = options.criticalThreshold ?? 0.95; // 95% utilization
    this.onWarning = options.onWarning || null;
    this.onCritical = options.onCritical || null;
    this.leakDetectionThreshold = options.leakDetectionThreshold ?? 30000; // 30 seconds
    this.connectionTimeout = options.connectionTimeout ?? options.timeout ?? DEFAULT_CONNECTION_TIMEOUT; // 30 seconds (#721)

    this.reset();
    this._pool = null;
    this._listeners = new Map();
    this._pendingAcquireTimers = new Map();
    this._activeConnections = new Map(); // Track connection lifecycle for leak & timeout detection
    this._leakCheckInterval = null;
  }

  /**
   * Reset all counters and metrics.
   */
  reset() {
    this.counters = {
      acquireRequests: 0,
      acquireSuccesses: 0,
      acquireFailures: 0,
      releases: 0,
      createRequests: 0,
      createSuccesses: 0,
      createFailures: 0,
      destroyRequests: 0,
      destroySuccesses: 0,
      destroyFailures: 0,
      timeouts: 0,
    };

    this.timing = {
      lastAcquireDurationMs: 0,
      maxAcquireDurationMs: 0,
      totalAcquireDurationMs: 0,
      acquireSamplesCount: 0,
    };

    this.lastFailure = null;
    this.lastWarningAt = null;
    this.lastCriticalAt = null;
  }

  /**
   * Attach monitor to a Knex instance or Tarn pool.
   *
   * @param {Object} knexOrPool - Knex database instance or Tarn pool
   * @returns {PoolMonitor} this
   */
  attach(knexOrPool) {
    if (!knexOrPool) return this;

    const pool = knexOrPool.client ? knexOrPool.client.pool : knexOrPool;
    if (!pool || typeof pool.on !== "function") {
      // Mock pool or pool without event emitter
      this._pool = pool;
      return this;
    }

    if (this._pool === pool) {
      return this; // Already attached to this pool
    }

    this.detach();
    this._pool = pool;

    const register = (event, handler) => {
      pool.on(event, handler);
      this._listeners.set(event, handler);
    };

    register("acquireRequest", (eventId) => {
      this.counters.acquireRequests++;
      this._pendingAcquireTimers.set(eventId, Date.now());
    });

    register("acquireSuccess", (eventId, resource) => {
      this.counters.acquireSuccesses++;
      const startTime = this._pendingAcquireTimers.get(eventId);
      if (startTime) {
        const duration = Date.now() - startTime;
        this._recordAcquireDuration(duration);
        this._pendingAcquireTimers.delete(eventId);
      }
      // Track connection for leak and timeout detection (#721)
      if (resource) {
        if (!resource.start) {
          resource.start = Date.now();
        }
        const cid = resource.__cid || resource.id || eventId;
        this._activeConnections.set(cid, {
          acquiredAt: Date.now(),
          start: resource.start,
          connection: resource,
          eventId,
        });
      }
      this._checkHealth();
    });

    register("acquireFail", (eventId, err) => {
      this.counters.acquireFailures++;
      this.lastFailure = {
        type: "acquireFail",
        error: err ? err.message : "Unknown acquire failure",
        timestamp: new Date().toISOString(),
      };
      this._pendingAcquireTimers.delete(eventId);
      logger.warn("Database pool acquire failed", {
        error: err ? err.message : null,
      });
    });

    register("release", (resource) => {
      this.counters.releases++;
      // Remove from active connections tracking
      if (resource) {
        const cid = resource.__cid || resource.id;
        if (cid && this._activeConnections.has(cid)) {
          this._activeConnections.delete(cid);
        } else {
          for (const [key, info] of this._activeConnections.entries()) {
            if (info.connection === resource) {
              this._activeConnections.delete(key);
              break;
            }
          }
        }
      }
      this._checkHealth();
    });

    register("createRequest", (eventId) => {
      this.counters.createRequests++;
    });

    register("createSuccess", (eventId, resource) => {
      this.counters.createSuccesses++;
    });

    register("createFail", (eventId, err) => {
      this.counters.createFailures++;
      this.lastFailure = {
        type: "createFail",
        error: err ? err.message : "Unknown create failure",
        timestamp: new Date().toISOString(),
      };
      logger.warn("Database pool connection creation failed", {
        error: err ? err.message : null,
      });
    });

    register("destroyRequest", (eventId, resource) => {
      this.counters.destroyRequests++;
    });

    register("destroySuccess", (eventId, resource) => {
      this.counters.destroySuccesses++;
    });

    register("destroyFail", (eventId, resource, err) => {
      this.counters.destroyFailures++;
    });

    register("poolDestroying", () => {
      this.detach();
    });

    // Start periodic leak and timeout detection
    this._startLeakDetection();

    return this;
  }

  /**
   * Detach all event listeners from pool.
   */
  detach() {
    this._stopLeakDetection();
    if (this._pool && typeof this._pool.removeListener === "function") {
      for (const [event, handler] of this._listeners.entries()) {
        this._pool.removeListener(event, handler);
      }
    }
    this._listeners.clear();
    this._pendingAcquireTimers.clear();
    this._activeConnections.clear();
    this._pool = null;
  }

  /**
   * Start periodic leak detection monitoring.
   * @private
   */
  _startLeakDetection() {
    this._stopLeakDetection();
    this._leakCheckInterval = setInterval(() => {
      this._checkForLeaks();
    }, 10000); // Check every 10 seconds
  }

  /**
   * Stop leak detection monitoring.
   * @private
   */
  _stopLeakDetection() {
    if (this._leakCheckInterval) {
      clearInterval(this._leakCheckInterval);
      this._leakCheckInterval = null;
    }
  }

  /**
   * Detect and destroy hung connections that have exceeded the timeout (#721).
   *
   * @param {number} [timeout] - Timeout in milliseconds (defaults to connectionTimeout)
   * @returns {Array} Array of timed-out connections
   */
  checkTimeouts(timeout = this.connectionTimeout) {
    const now = Date.now();
    const timedOut = [];

    for (const [cid, info] of this._activeConnections.entries()) {
      const connection = info.connection;
      const start = (connection && connection.start) || info.start || info.acquiredAt;
      if (now - start > timeout) {
        this.counters.timeouts++;
        timedOut.push(connection || info);
        if (connection && typeof connection.destroy === "function") {
          connection.destroy();
        } else if (this._pool && typeof this._pool.destroy === "function" && connection) {
          this._pool.destroy(connection);
        }
        this._activeConnections.delete(cid);
      }
    }

    if (timedOut.length > 0) {
      logger.warn("Database connection timeout detected", {
        timedOutCount: timedOut.length,
        timeoutMs: timeout,
      });
    }

    return timedOut;
  }

  /**
   * Check for long-held connections that may indicate leaks or timeouts.
   * @private
   */
  _checkForLeaks() {
    // Run timeout check first (#721)
    this.checkTimeouts();

    const now = Date.now();
    const leakedConnections = [];

    for (const [cid, info] of this._activeConnections.entries()) {
      const heldDuration = now - info.acquiredAt;
      if (heldDuration > this.leakDetectionThreshold) {
        leakedConnections.push({
          connectionId: cid,
          heldForMs: heldDuration,
          acquiredAt: new Date(info.acquiredAt).toISOString(),
        });
      }
    }

    if (leakedConnections.length > 0) {
      logger.warn("Potential connection leak detected", {
        leakedCount: leakedConnections.length,
        totalActive: this._activeConnections.size,
        threshold: this.leakDetectionThreshold,
        connections: leakedConnections,
      });
    }
  }

  _recordAcquireDuration(durationMs) {
    this.timing.lastAcquireDurationMs = durationMs;
    this.timing.totalAcquireDurationMs += durationMs;
    this.timing.acquireSamplesCount++;
    if (durationMs > this.timing.maxAcquireDurationMs) {
      this.timing.maxAcquireDurationMs = durationMs;
    }
  }

  _checkHealth() {
    const stats = this.getSnapshot();
    if (!stats || !stats.max) return;

    const utilization = stats.utilization;
    const now = Date.now();

    if (utilization >= this.criticalThreshold) {
      if (!this.lastCriticalAt || now - this.lastCriticalAt > 60000) {
        this.lastCriticalAt = now;
        logger.error("CRITICAL: Database connection pool nearly exhausted", {
          used: stats.used,
          max: stats.max,
          utilization: `${Math.round(utilization * 100)}%`,
          pendingAcquires: stats.pendingAcquires,
        });
        if (typeof this.onCritical === "function") {
          this.onCritical(stats);
        }
      }
    } else if (utilization >= this.warningThreshold) {
      if (!this.lastWarningAt || now - this.lastWarningAt > 60000) {
        this.lastWarningAt = now;
        logger.warn("WARNING: Database connection pool utilization high", {
          used: stats.used,
          max: stats.max,
          utilization: `${Math.round(utilization * 100)}%`,
          pendingAcquires: stats.pendingAcquires,
        });
        if (typeof this.onWarning === "function") {
          this.onWarning(stats);
        }
      }
    }
  }

  /**
   * Get instant snapshot of pool state.
   */
  getSnapshot() {
    if (!this._pool) return null;

    const min = this._pool.min ?? 0;
    const max = this._pool.max ?? 10;
    const used =
      typeof this._pool.numUsed === "function"
        ? this._pool.numUsed()
        : (this._pool.used ?? 0);
    const free =
      typeof this._pool.numFree === "function"
        ? this._pool.numFree()
        : (this._pool.free ?? 0);
    const pendingAcquires =
      typeof this._pool.numPendingAcquires === "function"
        ? this._pool.numPendingAcquires()
        : (this._pool.pendingAcquires ?? 0);
    const pendingCreates =
      typeof this._pool.numPendingCreates === "function"
        ? this._pool.numPendingCreates()
        : (this._pool.pendingCreates ?? 0);

    const utilization = max > 0 ? parseFloat((used / max).toFixed(4)) : 0;
    const saturation =
      max > 0 ? parseFloat(((used + pendingAcquires) / max).toFixed(4)) : 0;

    let status = "healthy";
    if (
      utilization >= this.criticalThreshold ||
      this.counters.acquireFailures > 0
    ) {
      status = "critical";
    } else if (utilization >= this.warningThreshold || pendingAcquires > 0) {
      status = "warning";
    }

    return {
      min,
      max,
      used,
      free,
      pendingAcquires,
      pendingCreates,
      utilization,
      saturation,
      status,
    };
  }

  /**
   * Get full metrics summary including counters and timing.
   */
  getMetrics() {
    const snapshot = this.getSnapshot() || {
      min: 0,
      max: 10,
      used: 0,
      free: 0,
      pendingAcquires: 0,
      pendingCreates: 0,
      utilization: 0,
      saturation: 0,
      status: "unknown",
    };

    const avgAcquireDurationMs =
      this.timing.acquireSamplesCount > 0
        ? parseFloat(
            (
              this.timing.totalAcquireDurationMs /
              this.timing.acquireSamplesCount
            ).toFixed(2),
          )
        : 0;

    return {
      ...snapshot,
      counters: { ...this.counters },
      timing: {
        lastAcquireDurationMs: this.timing.lastAcquireDurationMs,
        maxAcquireDurationMs: this.timing.maxAcquireDurationMs,
        avgAcquireDurationMs,
        acquireSamplesCount: this.timing.acquireSamplesCount,
      },
      lastFailure: this.lastFailure,
    };
  }

  /**
   * Format metrics in standard Prometheus exposition text format.
   *
   * @returns {string} Prometheus formatted metrics
   */
  toPrometheusMetrics() {
    const metrics = this.getMetrics();
    const lines = [];

    lines.push("# HELP db_pool_connections_min Minimum pool size");
    lines.push("# TYPE db_pool_connections_min gauge");
    lines.push(`db_pool_connections_min ${metrics.min}`);

    lines.push("# HELP db_pool_connections_max Maximum pool size");
    lines.push("# TYPE db_pool_connections_max gauge");
    lines.push(`db_pool_connections_max ${metrics.max}`);

    lines.push(
      "# HELP db_pool_connections_used Connections currently acquired from pool",
    );
    lines.push("# TYPE db_pool_connections_used gauge");
    lines.push(`db_pool_connections_used ${metrics.used}`);

    lines.push(
      "# HELP db_pool_connections_free Idle connections available in pool",
    );
    lines.push("# TYPE db_pool_connections_free gauge");
    lines.push(`db_pool_connections_free ${metrics.free}`);

    lines.push(
      "# HELP db_pool_connections_pending_acquires Pending connection acquire requests",
    );
    lines.push("# TYPE db_pool_connections_pending_acquires gauge");
    lines.push(
      `db_pool_connections_pending_acquires ${metrics.pendingAcquires}`,
    );

    lines.push(
      "# HELP db_pool_connections_pending_creates Pending connection creation operations",
    );
    lines.push("# TYPE db_pool_connections_pending_creates gauge");
    lines.push(`db_pool_connections_pending_creates ${metrics.pendingCreates}`);

    lines.push(
      "# HELP db_pool_connections_utilization Current connection pool utilization ratio (0.0 to 1.0)",
    );
    lines.push("# TYPE db_pool_connections_utilization gauge");
    lines.push(`db_pool_connections_utilization ${metrics.utilization}`);

    lines.push(
      "# HELP db_pool_acquires_total Total connection acquire attempts",
    );
    lines.push("# TYPE db_pool_acquires_total counter");
    lines.push(`db_pool_acquires_total ${metrics.counters.acquireRequests}`);

    lines.push(
      "# HELP db_pool_acquire_successes_total Total successful connection acquires",
    );
    lines.push("# TYPE db_pool_acquire_successes_total counter");
    lines.push(
      `db_pool_acquire_successes_total ${metrics.counters.acquireSuccesses}`,
    );

    lines.push(
      "# HELP db_pool_acquire_failures_total Total failed connection acquire attempts",
    );
    lines.push("# TYPE db_pool_acquire_failures_total counter");
    lines.push(
      `db_pool_acquire_failures_total ${metrics.counters.acquireFailures}`,
    );

    lines.push(
      "# HELP db_pool_releases_total Total connection releases back to pool",
    );
    lines.push("# TYPE db_pool_releases_total counter");
    lines.push(`db_pool_releases_total ${metrics.counters.releases}`);

    lines.push(
      "# HELP db_pool_creates_total Total connection creation attempts",
    );
    lines.push("# TYPE db_pool_creates_total counter");
    lines.push(`db_pool_creates_total ${metrics.counters.createRequests}`);

    lines.push(
      "# HELP db_pool_create_failures_total Total connection creation failures",
    );
    lines.push("# TYPE db_pool_create_failures_total counter");
    lines.push(
      `db_pool_create_failures_total ${metrics.counters.createFailures}`,
    );

    lines.push(
      "# HELP db_pool_timeouts_total Total connection timeouts detected",
    );
    lines.push("# TYPE db_pool_timeouts_total counter");
    lines.push(`db_pool_timeouts_total ${metrics.counters.timeouts}`);

    lines.push(
      "# HELP db_pool_acquire_duration_ms Average connection acquire latency in milliseconds",
    );
    lines.push("# TYPE db_pool_acquire_duration_ms gauge");
    lines.push(
      `db_pool_acquire_duration_ms ${metrics.timing.avgAcquireDurationMs}`,
    );

    return lines.join("\n") + "\n";
  }
}

// Global default monitor singleton
const defaultPoolMonitor = new PoolMonitor();

module.exports = {
  PoolMonitor,
  defaultPoolMonitor,
  checkConnectionTimeout,
  DEFAULT_CONNECTION_TIMEOUT,
};
