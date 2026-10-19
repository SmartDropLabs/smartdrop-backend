'use strict';

const knexFactory = require('knex');
const logger = require('../logger');

/**
 * Read replica support (#514).
 *
 * Routes read queries to replica databases to reduce primary DB load.
 * Write queries always go to the primary. Uses a simple round-robin
 * strategy across available replicas.
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
   * Get a replica connection for read queries (round-robin).
   * Falls back to primary if no replicas are configured.
   * @returns {import('knex').Knex}
   */
  getReplica() {
    if (!this.primary) this.init();

    if (this.replicas.length === 0) {
      return this.primary;
    }

    const replica = this.replicas[this.currentReplicaIndex];
    this.currentReplicaIndex = (this.currentReplicaIndex + 1) % this.replicas.length;
    return replica;
  }

  /**
   * Execute a read query against a replica (falls back to primary).
   * @param {Function} callback - Receives (db) and returns a query promise
   */
  async read(callback) {
    return callback(this.getReplica());
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
  }
}

/**
 * Create a replica router from environment variables.
 */
function createFromEnv() {
  const primaryUrl = process.env.DATABASE_URL;
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
