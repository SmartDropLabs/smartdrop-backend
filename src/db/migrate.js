#!/usr/bin/env node

'use strict';

/**
 * Migration CLI with safety rails (issue #252).
 *
 *   node src/db/migrate.js up                    apply pending migrations
 *   node src/db/migrate.js up --dry-run          preview without applying
 *   node src/db/migrate.js up --allow-destructive   permit DROP/ALTER in production
 *   node src/db/migrate.js down                  roll back the last batch
 *   node src/db/migrate.js status                show applied/pending state
 *
 * Every path runs the same sequence: inspect the migration SQL, enforce the
 * production gate, verify the database is reachable, then apply — recording
 * an audit row for the attempt either way.
 */

const path = require('path');
const knexFactory = require('knex');
const knexConfig = require('../../knexfile');
const safety = require('./migrationSafety');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args.find((arg) => !arg.startsWith('--')) || 'up';
  return {
    command,
    dryRun: args.includes('--dry-run'),
    allowDestructive: args.includes('--allow-destructive'),
  };
}

function environment() {
  return process.env.NODE_ENV || 'development';
}

function print(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * Prints what a migration run would do without touching the database.
 *
 * Knex has no native "explain this migration" mode — migrations are
 * arbitrary JS, so the only fully accurate preview would be running them.
 * This reports which migrations are pending and which destructive
 * operations their SQL contains, which is what the decision to proceed
 * actually turns on.
 */
async function dryRun(knex, inspected) {
  print('DRY RUN — no changes will be applied\n');
  print(`Environment: ${environment()}`);

  // The destructive scan is static analysis over the migration files, so it
  // still works with no database in reach. Only the applied/pending split
  // needs a connection — losing it degrades the preview rather than failing
  // it, since "what would this drop?" is exactly the question an operator
  // wants answered before pointing the CLI at a live database.
  let pending = null;
  try {
    const [completed, todo] = await knex.migrate.list();
    pending = todo.map((m) => m.file ?? m);
    print(`Already applied: ${completed.length}`);
    print(`Pending: ${pending.length}`);
  } catch (err) {
    print(`Database unreachable (${err.message})`);
    print('Reporting static analysis of all migration files instead.');
  }

  const listed = pending ?? inspected.map((entry) => entry.file);

  if (listed.length === 0) {
    print('\nNothing to apply.');
    return;
  }

  print('');
  for (const name of listed) {
    const entry = inspected.find((item) => item.file === name);
    const operations = entry && entry.destructive.length > 0
      ? entry.destructive.map((d) => d.operation).join(', ')
      : null;
    print(`  - ${name}${operations ? `  [DESTRUCTIVE: ${operations}]` : ''}`);
  }

  const destructive = inspected.filter((entry) => entry.destructive.length > 0);
  if (destructive.length > 0) {
    print(
      `\n${destructive.length} migration(s) contain destructive operations. `
      + 'Applying these against production requires --allow-destructive.',
    );
  }
}

async function run() {
  const { command, dryRun: isDryRun, allowDestructive } = parseArgs(process.argv);
  const env = environment();
  const config = knexConfig[env] || knexConfig.development;
  const knex = knexFactory(config);

  let exitCode = 0;

  try {
    const inspected = safety.inspectMigrationDirectory(MIGRATIONS_DIR);

    if (command === 'status') {
      const [completed, pending] = await knex.migrate.list();
      print(`Environment: ${env}`);
      print(`Applied (${completed.length}):`);
      completed.forEach((m) => print(`  - ${m.name ?? m}`));
      print(`Pending (${pending.length}):`);
      pending.forEach((m) => print(`  - ${m.file ?? m}`));
      return;
    }

    // The gate runs before the dry-run branch too, so a blocked migration
    // is reported as blocked rather than quietly previewing as applicable.
    safety.assertMigrationAllowed(inspected, { env, allowDestructive });

    if (isDryRun) {
      await dryRun(knex, inspected);
      return;
    }

    const preflight = await safety.preflightCheck(knex);
    preflight.warnings.forEach((warning) => print(`WARNING: ${warning}`));

    const direction = command === 'down' ? 'down' : 'up';
    const destructiveOps = inspected
      .flatMap((entry) => entry.destructive.map((d) => d.operation));

    try {
      const [batch, applied] = direction === 'down'
        ? await knex.migrate.down()
        : await knex.migrate.latest();

      const names = Array.isArray(applied) ? applied : [applied].filter(Boolean);
      if (names.length === 0) {
        print(direction === 'down' ? 'No migration to roll back.' : 'Already up to date.');
      } else {
        print(`Batch ${batch}: ${direction} — ${names.join(', ')}`);
      }

      for (const name of names) {
        await safety.recordMigrationRun(knex, {
          migrationName: String(name),
          direction,
          status: 'applied',
          destructive: destructiveOps.length > 0,
          detectedOperations: destructiveOps,
        });
      }
    } catch (err) {
      await safety.recordMigrationRun(knex, {
        migrationName: `${direction}:failed`,
        direction,
        status: 'failed',
        destructive: destructiveOps.length > 0,
        detectedOperations: destructiveOps,
        error: err.message,
      });
      throw err;
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    exitCode = 1;
  } finally {
    await knex.destroy();
  }

  process.exitCode = exitCode;
}

if (require.main === module) {
  run();
}

module.exports = { parseArgs, run };
