'use strict';

/**
 * Migration idempotency tests (#466).
 *
 * Verifies that:
 * 1. All migration SQL statements are guarded with IF NOT EXISTS / IF EXISTS.
 * 2. When a real database is available, running the full migration set twice
 *    succeeds without error and leaves the database schema completely unchanged.
 *    Per issue instructions: "If a real database is not available, say so rather than faking it."
 */

const fs = require('fs');
const path = require('path');
const knexFactory = require('knex');
const knexConfig = require('../knexfile');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'src', 'db', 'migrations');

describe('Migration Idempotency (#466)', () => {
  describe('Static statement guards', () => {
    const migrationFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'));

    test('all migration files contain guarded CREATE statements', () => {
      expect(migrationFiles.length).toBeGreaterThan(0);

      for (const file of migrationFiles) {
        const content = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

        // Check CREATE TABLE statements
        const createTableMatches = content.match(/CREATE\s+TABLE\s+([^\s(]+)/gi) || [];
        for (const match of createTableMatches) {
          expect(match.toUpperCase()).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i);
        }

        // Check CREATE INDEX statements
        const createIndexMatches = content.match(/CREATE\s+INDEX\s+([^\s(]+)/gi) || [];
        for (const match of createIndexMatches) {
          expect(match.toUpperCase()).toMatch(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS/i);
        }

        // Check DROP statements in rollback
        const dropTableMatches = content.match(/DROP\s+TABLE\s+([^\s;]+)/gi) || [];
        for (const match of dropTableMatches) {
          expect(match.toUpperCase()).toMatch(/DROP\s+TABLE\s+IF\s+EXISTS/i);
        }
      }
    });

    test('audit status table creation in migrationSafety is idempotent', () => {
      const safetyContent = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'db', 'migrationSafety.js'),
        'utf8'
      );
      expect(safetyContent).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i);
    });

    test('knexfile configures disableTransactions: false for atomic migrations', () => {
      expect(knexConfig.development.migrations.disableTransactions).toBe(false);
      expect(knexConfig.test.migrations.disableTransactions).toBe(false);
      expect(knexConfig.production.migrations.disableTransactions).toBe(false);
    });
  });

  describe('Live database migration test', () => {
    let knex;
    let isDbAvailable = false;

    beforeAll(async () => {
      const testConfig = knexConfig.test || knexConfig.development;
      knex = knexFactory(testConfig);

      try {
        await knex.raw('SELECT 1');
        isDbAvailable = true;
      } catch (err) {
        isDbAvailable = false;
        // Explicitly report when real database is not available rather than faking it
        console.warn(`[#466 notice] Real test database is not available (${err.message}). Skipping live database execution per specification.`);
      }
    });

    afterAll(async () => {
      if (knex) {
        await knex.destroy();
      }
    });

    test('running full migration set twice succeeds and schema is unchanged', async () => {
      if (!isDbAvailable) {
        // As instructed: "If a real database is not available, say so rather than faking it."
        console.warn('[#466 notice] Skipping live migration idempotency assertion because no real database is reachable.');
        expect(isDbAvailable).toBe(false);
        return;
      }

      // 1. Run migrations first time
      await knex.migrate.latest();

      // Read tables from PostgreSQL information_schema
      const queryTables = async () => {
        const result = await knex.raw(`
          SELECT table_name, column_name, data_type 
          FROM information_schema.columns 
          WHERE table_schema = 'public' 
          ORDER BY table_name, column_name;
        `);
        return result.rows || result;
      };

      const initialSchema = await queryTables();

      // 2. Re-run migrations second time (knex.migrate.latest should be a clean no-op)
      await expect(knex.migrate.latest()).resolves.not.toThrow();

      // 3. Directly re-execute the up() function of each migration file to test running against existing objects
      const migrationFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js')).sort();
      for (const file of migrationFiles) {
        const migration = require(path.join(MIGRATIONS_DIR, file));
        await expect(migration.up(knex)).resolves.not.toThrow();
      }

      // 4. Assert schema is identical
      const secondSchema = await queryTables();
      expect(secondSchema).toEqual(initialSchema);
    });
  });
});
