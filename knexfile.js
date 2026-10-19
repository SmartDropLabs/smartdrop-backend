'use strict';

/**
 * Knex configuration (issue #252).
 *
 * Migration files already existed under src/db/migrations, but there was no
 * knexfile and knex was not a dependency, so nothing could actually run
 * them. This wires them up and points knex at the same DATABASE_URL the
 * rest of the service uses.
 *
 * `migrations.tableName` is left at knex's default (`knex_migrations`);
 * the dedicated status tracking the issue asks for lives in a separate
 * table written by src/db/migrationSafety.js, so knex's own bookkeeping
 * stays untouched and recoverable.
 */

require('dotenv').config();

const path = require('path');

const migrations = {
  directory: path.join(__dirname, 'src', 'db', 'migrations'),
  extension: 'js',
};

function connectionFor(fallback) {
  return process.env.DATABASE_URL || fallback;
}

// Enable SSL for database connections in production (issue #529).
// Encrypts data in transit to prevent interception and meet compliance
// requirements. Set DB_SSL=false to disable if the database doesn't support it.
function sslConfig() {
  if (process.env.DB_SSL === 'false') return false;
  return { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' };
}

module.exports = {
  development: {
    client: 'pg',
    connection: connectionFor('postgres://localhost/smartdrop'),
    migrations,
  },

  test: {
    client: 'pg',
    connection: connectionFor('postgres://localhost/smartdrop_test'),
    migrations,
  },

  production: {
    client: 'pg',
    connection: {
      connectionString: connectionFor(undefined),
      ssl: sslConfig(),
    },
    pool: { min: 2, max: 10 },
    migrations,
  },
};
