'use strict';

/**
 * Migration safety checks (issue #252).
 */

const path = require('path');
const safety = require('../src/db/migrationSafety');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'src', 'db', 'migrations');

describe('findDestructiveOperations', () => {
  test('flags DROP TABLE', () => {
    expect(safety.findDestructiveOperations('DROP TABLE webhooks;'))
      .toEqual([{ operation: 'DROP TABLE' }]);
  });

  test('flags DROP COLUMN', () => {
    expect(safety.findDestructiveOperations('ALTER TABLE webhooks DROP COLUMN secret;'))
      .toContainEqual({ operation: 'DROP COLUMN' });
  });

  test('flags TRUNCATE and DELETE FROM', () => {
    expect(safety.findDestructiveOperations('TRUNCATE webhooks;'))
      .toContainEqual({ operation: 'TRUNCATE' });
    expect(safety.findDestructiveOperations('DELETE FROM webhooks WHERE 1=1;'))
      .toContainEqual({ operation: 'DELETE FROM' });
  });

  test('flags a column type change, which can silently truncate data', () => {
    expect(safety.findDestructiveOperations('ALTER TABLE t ALTER COLUMN c TYPE varchar(10);'))
      .toContainEqual({ operation: 'ALTER COLUMN TYPE' });
  });

  test('flags SET NOT NULL, which fails on existing null rows', () => {
    expect(safety.findDestructiveOperations('ALTER TABLE t ALTER COLUMN c SET NOT NULL;'))
      .toContainEqual({ operation: 'SET NOT NULL' });
  });

  test('is case insensitive', () => {
    expect(safety.findDestructiveOperations('drop table webhooks;'))
      .toEqual([{ operation: 'DROP TABLE' }]);
  });

  test('ignores an additive migration', () => {
    const sql = 'CREATE TABLE t (id TEXT PRIMARY KEY); CREATE INDEX idx ON t (id);';
    expect(safety.findDestructiveOperations(sql)).toEqual([]);
  });

  test('does not trip on a destructive keyword inside a line comment', () => {
    const sql = '-- this migration does not DROP TABLE anything\nCREATE TABLE t (id TEXT);';
    expect(safety.findDestructiveOperations(sql)).toEqual([]);
  });

  test('does not trip on a destructive keyword inside a block comment', () => {
    const sql = '/* previously we would DROP TABLE t */ CREATE TABLE t (id TEXT);';
    expect(safety.findDestructiveOperations(sql)).toEqual([]);
  });

  test('reports every distinct destructive operation in one migration', () => {
    const sql = 'DROP TABLE a; TRUNCATE b; ALTER TABLE c DROP COLUMN d;';
    const found = safety.findDestructiveOperations(sql).map((f) => f.operation);
    expect(found).toEqual(expect.arrayContaining(['DROP TABLE', 'TRUNCATE', 'DROP COLUMN']));
  });

  test('handles empty and non-string input without throwing', () => {
    expect(safety.findDestructiveOperations('')).toEqual([]);
    expect(safety.findDestructiveOperations(null)).toEqual([]);
    expect(safety.findDestructiveOperations(undefined)).toEqual([]);
  });
});

describe('inspectMigrationDirectory', () => {
  test('inspects the real migration files in the repository', () => {
    const inspected = safety.inspectMigrationDirectory(MIGRATIONS_DIR);

    expect(inspected.length).toBeGreaterThan(0);
    expect(inspected[0]).toEqual(expect.objectContaining({
      file: expect.stringMatching(/\.js$/),
      destructive: expect.any(Array),
    }));
  });

  test('detects the DROP TABLE in the existing rollback paths', () => {
    const inspected = safety.inspectMigrationDirectory(MIGRATIONS_DIR);
    const withDrops = inspected.filter((entry) =>
      entry.destructive.some((d) => d.operation === 'DROP TABLE'));

    // Every migration's down() drops the tables its up() created.
    expect(withDrops.length).toBe(inspected.length);
  });

  test('returns an empty list for a directory that does not exist', () => {
    expect(safety.inspectMigrationDirectory(path.join(MIGRATIONS_DIR, 'nope'))).toEqual([]);
  });
});

describe('assertMigrationAllowed', () => {
  const destructive = [{ file: 'x.js', destructive: [{ operation: 'DROP TABLE' }] }];
  const additive = [{ file: 'y.js', destructive: [] }];

  test('allows additive migrations in production', () => {
    expect(safety.assertMigrationAllowed(additive, { env: 'production' }))
      .toEqual({ allowed: true, destructive: [] });
  });

  test('allows destructive migrations outside production', () => {
    const result = safety.assertMigrationAllowed(destructive, { env: 'development' });
    expect(result.allowed).toBe(true);
  });

  test('blocks destructive migrations in production without the opt-in', () => {
    expect(() => safety.assertMigrationAllowed(destructive, { env: 'production' }))
      .toThrow(/Refusing to run destructive migration/);
  });

  test('names the offending file and operation when it blocks', () => {
    try {
      safety.assertMigrationAllowed(destructive, { env: 'production' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.code).toBe('DESTRUCTIVE_MIGRATION_BLOCKED');
      expect(err.message).toContain('x.js');
      expect(err.message).toContain('DROP TABLE');
    }
  });

  test('allows destructive migrations in production with the explicit opt-in', () => {
    const result = safety.assertMigrationAllowed(destructive, {
      env: 'production',
      allowDestructive: true,
    });
    expect(result.allowed).toBe(true);
  });
});

describe('preflightCheck', () => {
  function knexStub({ raw }) {
    return { raw };
  }

  test('reports connected and the database size on a healthy database', async () => {
    const knex = knexStub({
      raw: jest.fn(async (sql) => {
        if (sql.includes('pg_database_size')) return { rows: [{ size: '12345' }] };
        return { rows: [{ '?column?': 1 }] };
      }),
    });

    const result = await safety.preflightCheck(knex);

    expect(result.connected).toBe(true);
    expect(result.databaseSizeBytes).toBe(12345);
    expect(result.warnings).toEqual([]);
  });

  test('throws when the database is unreachable', async () => {
    const knex = knexStub({ raw: jest.fn(async () => { throw new Error('ECONNREFUSED'); }) });

    await expect(safety.preflightCheck(knex)).rejects.toThrow(/database unreachable/);
  });

  test('warns rather than failing when the size query is not permitted', async () => {
    const knex = knexStub({
      raw: jest.fn(async (sql) => {
        if (sql.includes('pg_database_size')) throw new Error('permission denied');
        return { rows: [] };
      }),
    });

    const result = await safety.preflightCheck(knex);

    expect(result.connected).toBe(true);
    expect(result.databaseSizeBytes).toBeNull();
    expect(result.warnings[0]).toMatch(/Could not read database size/);
  });

  test('warns when the database exceeds the configured size limit', async () => {
    const knex = knexStub({
      raw: jest.fn(async (sql) => {
        if (sql.includes('pg_database_size')) return { rows: [{ size: '5000' }] };
        return { rows: [] };
      }),
    });

    const result = await safety.preflightCheck(knex, { maxDatabaseBytes: 1000 });

    expect(result.warnings.some((w) => w.includes('exceeds configured limit'))).toBe(true);
  });
});

describe('recordMigrationRun', () => {
  test('never fails a migration because the audit write failed', async () => {
    const knex = () => { throw new Error('table missing'); };
    knex.schema = { hasTable: jest.fn(async () => { throw new Error('no schema access'); }) };

    const result = await safety.recordMigrationRun(knex, {
      migrationName: 'x.js',
      direction: 'up',
      status: 'applied',
    });

    expect(result.recorded).toBe(false);
    expect(result.error).toBeDefined();
  });

  test('writes an audit row describing the attempt', async () => {
    const inserted = [];
    const knex = jest.fn(() => ({ insert: async (row) => { inserted.push(row); } }));
    knex.schema = { hasTable: jest.fn(async () => true) };

    const result = await safety.recordMigrationRun(knex, {
      migrationName: '20260701000000_add_webhooks.js',
      direction: 'up',
      status: 'applied',
      destructive: true,
      detectedOperations: ['DROP TABLE'],
      appliedBy: 'ci',
    });

    expect(result.recorded).toBe(true);
    expect(inserted[0]).toEqual(expect.objectContaining({
      migration_name: '20260701000000_add_webhooks.js',
      direction: 'up',
      status: 'applied',
      destructive: true,
      detected_operations: 'DROP TABLE',
      applied_by: 'ci',
    }));
  });
});
