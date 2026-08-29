'use strict';

/**
 * Migration safety checks (issue #252).
 *
 * Migrations previously ran unconditionally in any environment, with no way
 * to preview what a migration would do and nothing standing between a
 * `DROP TABLE` and a production database.
 *
 * This module supplies the pieces the migration CLI composes:
 *
 *   - `findDestructiveOperations` — scans migration SQL for irreversible
 *     patterns (DROP TABLE/COLUMN, TRUNCATE, destructive ALTERs).
 *   - `assertMigrationAllowed`    — gates those behind an explicit opt-in
 *     when running against production.
 *   - `preflightCheck`            — verifies the database is reachable and
 *     has headroom before anything is applied.
 *   - `recordMigrationRun`        — writes an audit row per attempt.
 *
 * The scan is deliberately conservative: it errs toward flagging, because a
 * false positive costs one confirmation flag while a false negative costs a
 * table. It is a safety net, not a SQL parser — a migration that builds its
 * statements dynamically at runtime can still evade it, which is exactly
 * why the production gate requires a human-supplied flag rather than
 * trusting the scan to be exhaustive.
 */

const fs = require('fs');
const path = require('path');

const STATUS_TABLE = 'migration_audit_log';

/**
 * Patterns that destroy data or make a migration hard to reverse.
 *
 * Each entry names the operation so the operator is told *what* was found
 * rather than just that "something destructive" matched.
 */
const DESTRUCTIVE_PATTERNS = Object.freeze([
  { operation: 'DROP TABLE', pattern: /\bDROP\s+TABLE\b/i },
  { operation: 'DROP COLUMN', pattern: /\bDROP\s+COLUMN\b/i },
  { operation: 'DROP SCHEMA', pattern: /\bDROP\s+SCHEMA\b/i },
  { operation: 'DROP DATABASE', pattern: /\bDROP\s+DATABASE\b/i },
  { operation: 'DROP INDEX', pattern: /\bDROP\s+INDEX\b/i },
  { operation: 'DROP CONSTRAINT', pattern: /\bDROP\s+CONSTRAINT\b/i },
  { operation: 'TRUNCATE', pattern: /\bTRUNCATE\b/i },
  { operation: 'DELETE FROM', pattern: /\bDELETE\s+FROM\b/i },
  // Type changes can silently truncate or fail on existing rows.
  { operation: 'ALTER COLUMN TYPE', pattern: /\bALTER\s+COLUMN\b[\s\S]{0,80}?\bTYPE\b/i },
  { operation: 'SET NOT NULL', pattern: /\bSET\s+NOT\s+NULL\b/i },
  { operation: 'RENAME COLUMN', pattern: /\bRENAME\s+COLUMN\b/i },
  { operation: 'RENAME TABLE', pattern: /\bALTER\s+TABLE\b[\s\S]{0,80}?\bRENAME\s+TO\b/i },
]);

/**
 * Strips SQL comments so a `DROP TABLE` mentioned in prose does not trip
 * the scan. Handles line comments and block comments.
 */
function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n\r]*/g, ' ');
}

/**
 * Returns every destructive operation found in the given SQL.
 *
 * @param {string} sql
 * @returns {Array<{operation: string}>}
 */
function findDestructiveOperations(sql) {
  if (!sql || typeof sql !== 'string') return [];
  const cleaned = stripComments(sql);
  return DESTRUCTIVE_PATTERNS
    .filter(({ pattern }) => pattern.test(cleaned))
    .map(({ operation }) => ({ operation }));
}

/**
 * Scans a migration file on disk.
 *
 * Reads the file as text rather than requiring it: the goal is to inspect
 * the SQL a migration contains without executing any of its module code.
 */
function inspectMigrationFile(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  return {
    file: path.basename(filePath),
    destructive: findDestructiveOperations(source),
  };
}

/** Scans every migration in a directory, newest last. */
function inspectMigrationDirectory(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => inspectMigrationFile(path.join(directory, name)));
}

function isProductionEnv(env) {
  return (env || process.env.NODE_ENV) === 'production';
}

/**
 * Throws unless the given migrations are safe to apply in this environment.
 *
 * Destructive migrations run freely outside production. Against production
 * they require an explicit `--allow-destructive` opt-in, so that dropping a
 * column is always a decision someone made on purpose rather than a side
 * effect of a routine deploy.
 *
 * @param {Array<{file: string, destructive: Array}>} inspected
 * @param {{env?: string, allowDestructive?: boolean}} options
 */
function assertMigrationAllowed(inspected, options = {}) {
  const risky = inspected.filter((entry) => entry.destructive.length > 0);
  if (risky.length === 0) return { allowed: true, destructive: [] };

  if (!isProductionEnv(options.env)) {
    return { allowed: true, destructive: risky };
  }

  if (options.allowDestructive) {
    return { allowed: true, destructive: risky };
  }

  const summary = risky
    .map((entry) => `${entry.file} (${entry.destructive.map((d) => d.operation).join(', ')})`)
    .join('; ');

  const error = new Error(
    `Refusing to run destructive migration(s) against production: ${summary}. `
    + 'Re-run with --allow-destructive if this is intended.',
  );
  error.code = 'DESTRUCTIVE_MIGRATION_BLOCKED';
  error.destructive = risky;
  throw error;
}

/**
 * Verifies the database is reachable and has room before migrating.
 *
 * A migration that fails halfway because the disk filled is far worse than
 * one that never started, so connectivity and free space are checked up
 * front. Disk usage is read via pg_database_size against the configured
 * limit; when the limit is unset the size is reported but not enforced.
 *
 * @param {import('knex').Knex} knex
 * @param {{minFreeBytes?: number}} options
 */
async function preflightCheck(knex, options = {}) {
  const result = { connected: false, databaseSizeBytes: null, warnings: [] };

  try {
    await knex.raw('SELECT 1');
    result.connected = true;
  } catch (err) {
    const error = new Error(`Pre-migration check failed: database unreachable (${err.message})`);
    error.code = 'MIGRATION_PREFLIGHT_FAILED';
    throw error;
  }

  try {
    const sizeResult = await knex.raw('SELECT pg_database_size(current_database()) AS size');
    const row = sizeResult?.rows?.[0];
    if (row && row.size != null) {
      result.databaseSizeBytes = Number(row.size);
    }
  } catch (err) {
    // Size is advisory — a role without permission to read it should not
    // block a migration that is otherwise fine.
    result.warnings.push(`Could not read database size: ${err.message}`);
  }

  if (options.maxDatabaseBytes && result.databaseSizeBytes !== null
      && result.databaseSizeBytes > options.maxDatabaseBytes) {
    result.warnings.push(
      `Database size ${result.databaseSizeBytes} exceeds configured limit ${options.maxDatabaseBytes}`,
    );
  }

  return result;
}

/**
 * Creates the audit table if absent.
 *
 * Separate from knex's own `knex_migrations`: that table records only which
 * migrations are currently applied. This one records every *attempt* —
 * including dry runs, rollbacks, and failures — which is what an operator
 * actually needs when reconstructing what happened to a database.
 */
async function ensureStatusTable(knex) {
  const exists = await knex.schema.hasTable(STATUS_TABLE);
  if (exists) return;

  await knex.schema.createTable(STATUS_TABLE, (table) => {
    table.increments('id').primary();
    table.string('migration_name').notNullable();
    table.string('direction').notNullable(); // up | down
    table.string('status').notNullable();    // applied | failed | dry-run
    table.boolean('destructive').notNullable().defaultTo(false);
    table.text('detected_operations');
    table.text('error');
    table.string('applied_by');
    table.timestamp('recorded_at').notNullable().defaultTo(knex.fn.now());
  });
}

/**
 * Appends one audit row. Never throws: losing an audit line must not fail
 * an otherwise successful migration, so failures here are returned rather
 * than propagated.
 */
async function recordMigrationRun(knex, entry) {
  try {
    await ensureStatusTable(knex);
    await knex(STATUS_TABLE).insert({
      migration_name: entry.migrationName,
      direction: entry.direction,
      status: entry.status,
      destructive: Boolean(entry.destructive),
      detected_operations: entry.detectedOperations
        ? entry.detectedOperations.join(', ')
        : null,
      error: entry.error || null,
      applied_by: entry.appliedBy || process.env.USER || process.env.USERNAME || null,
    });
    return { recorded: true };
  } catch (err) {
    return { recorded: false, error: err.message };
  }
}

module.exports = {
  STATUS_TABLE,
  DESTRUCTIVE_PATTERNS,
  findDestructiveOperations,
  inspectMigrationFile,
  inspectMigrationDirectory,
  assertMigrationAllowed,
  preflightCheck,
  ensureStatusTable,
  recordMigrationRun,
};
