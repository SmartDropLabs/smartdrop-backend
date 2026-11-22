'use strict';

const knexFactory = require('knex');
const encryption = require('./encryption');
const logger = require('../logger');

/**
 * Read replica support (#514).
 *
 * Routes read queries to replica databases to reduce primary DB load.
 * Write queries always go to the primary. Reads round-robin across replicas
 * that are currently healthy. A replica is marked unhealthy when a read on it
 * fails with a connection-level error (#666), and marked healthy again by
 * checkReplicaHealth(). When no replica is healthy, reads fall back to the
 * primary.
 *
 * Configuration:
 *   DATABASE_URL          — primary (write) connection string
 *   DATABASE_REPLICA_URLS — comma-separated replica connection strings
 */

class ReadReplicaRouter {
  constructor(options = {}) {
    this.primaryConfig = options.primary;
    this.replicaConfigs = options.replicas ?? [];
    this.primary = null;
    this.replicas = [];
    this.currentReplicaIndex = 0;
    // Replicas marked unhealthy. Keyed by object, so replicas that are not
    // in the set count as healthy and the set survives replica list changes.
    this.unhealthyReplicas = new WeakSet();
  }

  /**
   * Initialize the primary and replica connection pools.
   */
  init() {
    this.primary = knexFactory({
      client: 'pg',
      connection: this.primaryConfig,
      pool: { min: 2, max: 10 },
    });

    this.replicas = this.replicaConfigs.map((config) =>
      knexFactory({
        client: 'pg',
        connection: config,
        pool: { min: 2, max: 10 },
      }),
    );

    logger.info({
      replicaCount: this.replicas.length,
    }, 'Read replica router initialized');
  }

  /**
   * Get the primary (write) connection.
   * @returns {import('knex').Knex}
   */
  getPrimary() {
    if (!this.primary) this.init();
    return this.primary;
  }

  /**
   * Index of the next healthy replica in round-robin order, skipping any index
   * in `excluded`. Returns -1 when there is none.
   * @param {Set<number>} [excluded]
   * @returns {number}
   */
  _nextHealthyIndex(excluded = new Set()) {
    const count = this.replicas.length;
    for (let offset = 0; offset < count; offset += 1) {
      const index = (this.currentReplicaIndex + offset) % count;
      if (!excluded.has(index) && !this.unhealthyReplicas.has(this.replicas[index])) {
        this.currentReplicaIndex = (index + 1) % count;
        return index;
      }
    }
    return -1;
  }

  /**
   * Get a replica connection for read queries (round-robin over healthy replicas).
   * Falls back to primary if no replicas are configured or none are healthy.
   * @returns {import('knex').Knex}
   */
  getReplica() {
    if (!this.primary) this.init();

    if (this.replicas.length === 0) {
      return this.primary;
    }

    const index = this._nextHealthyIndex();
    if (index === -1) {
      logger.warn({ replicaCount: this.replicas.length }, 'No healthy read replica; routing read to primary');
      return this.primary;
    }
    return this.replicas[index];
  }

  /**
   * Mark a replica as unhealthy so reads stop going to it (#666).
   * @param {import('knex').Knex} replica
   * @param {Error} [err]
   */
  markReplicaUnhealthy(replica, err) {
    if (this.unhealthyReplicas.has(replica)) return;
    this.unhealthyReplicas.add(replica);
    logger.warn({ error: err?.message }, 'Read replica marked unhealthy');
  }

  /**
   * Mark a replica as healthy again so reads can use it.
   * @param {import('knex').Knex} replica
   */
  markReplicaHealthy(replica) {
    if (!this.unhealthyReplicas.has(replica)) return;
    this.unhealthyReplicas.delete(replica);
    logger.info('Read replica marked healthy');
  }

  /**
   * Ping every replica with `select 1` and update its health (#666).
   * Call this on a timer. Unhealthy replicas only return to rotation through it.
   * @returns {Promise<boolean[]>} Health per replica, in configured order.
   */
  async checkReplicaHealth() {
    if (!this.primary) this.init();
    const results = [];
    for (const replica of this.replicas) {
      try {
        await replica.raw('select 1');
        this.markReplicaHealthy(replica);
        results.push(true);
      } catch (err) {
        this.markReplicaUnhealthy(replica, err);
        results.push(false);
      }
    }
    return results;
  }

  /**
   * Execute a read query against a replica. If the replica fails with a
   * connection error it is marked unhealthy, and the read is retried on the
   * next healthy replica, then on the primary (#666). Other errors are rethrown.
   * @param {Function} callback - Receives (db) and returns a query promise
   */
  async read(callback) {
    if (!this.primary) this.init();
    const tried = new Set();
    for (;;) {
      if (this.replicas.length === 0) return callback(this.primary);
      const index = this._nextHealthyIndex(tried);
      if (index === -1) return callback(this.primary);
      const replica = this.replicas[index];
      try {
        return await callback(replica);
      } catch (err) {
        if (!isConnectionError(err)) throw err;
        this.markReplicaUnhealthy(replica, err);
        tried.add(index);
      }
    }
  }

  /**
   * Execute a write query against the primary.
   * @param {Function} callback - Receives (db) and returns a query promise
   */
  async write(callback) {
    return callback(this.getPrimary());
  }

  /**
   * Close all connection pools.
   */
  async destroy() {
    if (this.primary) {
      await this.primary.destroy();
      this.primary = null;
    }
    for (const replica of this.replicas) {
      await replica.destroy();
    }
    this.replicas = [];
    this.unhealthyReplicas = new WeakSet();
  }
}

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENOTFOUND',
  // PostgreSQL: 57P01 admin_shutdown, 57P02 crash_shutdown, 57P03 cannot_connect_now.
  '57P01', '57P02', '57P03',
]);

/**
 * True for errors that mean the replica itself is unreachable, not that the
 * query was bad. Only these cause a replica to be marked unhealthy.
 * @param {Error} err
 * @returns {boolean}
 */
function isConnectionError(err) {
  if (!err) return false;
  const code = String(err.code ?? '').toUpperCase();
  if (CONNECTION_ERROR_CODES.has(code)) return true;
  // PostgreSQL class 08: connection exception.
  if (code.startsWith('08')) return true;
  return err.name === 'KnexTimeoutError';
}

/**
 * Create a replica router from environment variables.
 */
function createFromEnv() {
  const primaryUrl = process.env.DATABASE_URL_ENCRYPTED
    ? encryption.decrypt(process.env.DATABASE_URL_ENCRYPTED)
    : process.env.DATABASE_URL;
  const replicaUrls = (process.env.DATABASE_REPLICA_URLS ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);

  return new ReadReplicaRouter({
    primary: primaryUrl,
    replicas: replicaUrls,
  });
}

module.exports = {
  ReadReplicaRouter,
  createFromEnv,
};
