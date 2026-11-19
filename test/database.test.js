'use strict';

const { withTransaction, transaction, setDb } = require('../src/database');
const { logUsage } = require('../src/services/apiKeyAuditLog');

describe('Database transactions (#454)', () => {
  let mockKnex;
  let mockTrx;
  let records;
  let rollbackCalled;
  let commitCalled;
  let completed;

  beforeEach(() => {
    records = [];
    rollbackCalled = false;
    commitCalled = false;
    completed = false;

    // Create a mock transaction object that acts as a query builder / function
    mockTrx = jest.fn((table) => ({
      insert: jest.fn(async (row) => {
        records.push({ table, ...row });
        return [row];
      }),
      select: jest.fn(async () => records),
      where: jest.fn().mockReturnThis(),
    }));

    mockTrx.commit = jest.fn(async () => {
      commitCalled = true;
      completed = true;
    });

    mockTrx.rollback = jest.fn(async () => {
      rollbackCalled = true;
      completed = true;
      // In a real rollback, written rows in this transaction are discarded
      records = [];
    });

    mockTrx.isCompleted = jest.fn(() => completed);

    mockTrx.transaction = jest.fn(async () => {
      // Nested savepoint
      let savepointCompleted = false;
      const savepoint = jest.fn((table) => ({
        insert: jest.fn(async (row) => {
          records.push({ table, ...row });
          return [row];
        }),
      }));
      savepoint.commit = jest.fn(async () => {
        savepointCompleted = true;
      });
      savepoint.rollback = jest.fn(async () => {
        savepointCompleted = true;
      });
      savepoint.isCompleted = jest.fn(() => savepointCompleted);
      return savepoint;
    });

    // Mock knex db instance
    mockKnex = jest.fn((table) => ({
      insert: jest.fn(async (row) => {
        records.push({ table, ...row });
        return [row];
      }),
    }));

    mockKnex.transaction = jest.fn(async () => mockTrx);
    setDb(mockKnex);
  });

  afterEach(() => {
    setDb(null);
  });

  test('success case: writes rows, commits transaction, and persists all writes', async () => {
    const result = await withTransaction(mockKnex, async (trx) => {
      await trx('users').insert({ id: 1, name: 'Alice' });
      await trx('users').insert({ id: 2, name: 'Bob' });
      return { count: 2 };
    });

    expect(result).toEqual({ count: 2 });
    expect(commitCalled).toBe(true);
    expect(rollbackCalled).toBe(false);
    expect(records.length).toBe(2);
    expect(records[0]).toMatchObject({ table: 'users', id: 1, name: 'Alice' });
    expect(records[1]).toMatchObject({ table: 'users', id: 2, name: 'Bob' });
  });

  test('atomicity & rollback: rolls back all writes when an error is thrown midway', async () => {
    class MidstreamError extends Error {
      constructor(msg) {
        super(msg);
        this.name = 'MidstreamError';
      }
    }

    await expect(
      withTransaction(mockKnex, async (trx) => {
        await trx('accounts').insert({ id: 'acc_1', balance: 100 });
        await trx('accounts').insert({ id: 'acc_2', balance: 200 });

        // Simulating error midway
        throw new MidstreamError('Something went wrong after inserting 2 rows');
      })
    ).rejects.toThrow(MidstreamError);

    expect(rollbackCalled).toBe(true);
    expect(commitCalled).toBe(false);
    // Rolled back - none persisted
    expect(records.length).toBe(0);
  });

  test('error preservation: original error is rethrown and not replaced by rollback errors', async () => {
    class BusinessLogicError extends Error {
      constructor(msg) {
        super(msg);
        this.name = 'BusinessLogicError';
      }
    }

    // Simulate rollback error (e.g. socket connection broken during rollback)
    mockTrx.rollback = jest.fn().mockRejectedValue(new Error('Connection lost during rollback'));

    await expect(
      withTransaction(mockKnex, async (trx) => {
        await trx('transfers').insert({ id: 'tx_1', amount: 50 });
        throw new BusinessLogicError('Transfer validation failed');
      })
    ).rejects.toThrow(BusinessLogicError);

    expect(mockTrx.rollback).toHaveBeenCalled();
  });

  test('guarantees connection release even if unexpected exception occurs', async () => {
    completed = false;
    try {
      await withTransaction(mockKnex, async () => {
        throw new Error('Fatal error');
      });
    } catch (_) {}

    expect(mockTrx.rollback).toHaveBeenCalled();
  });

  test('nested transaction / savepoint support', async () => {
    const result = await withTransaction(mockKnex, async (trx) => {
      await trx('parent').insert({ id: 1 });

      const nestedResult = await withTransaction(mockKnex, async (savepoint) => {
        await savepoint('child').insert({ id: 2, parent_id: 1 });
        return 'nested_ok';
      }, { trx });

      expect(nestedResult).toBe('nested_ok');
      return 'parent_ok';
    });

    expect(result).toBe('parent_ok');
    expect(commitCalled).toBe(true);
  });

  test('apiKeyAuditLog caller executes on trx when provided', async () => {
    await withTransaction(mockKnex, async (trx) => {
      await logUsage({
        keyId: 'key_123',
        endpoint: 'GET /api/v1/prices',
        ipAddress: '127.0.0.1',
        statusCode: 200,
        responseTimeMs: 15,
      }, trx);
    });

    expect(mockTrx).toHaveBeenCalledWith('api_key_audit_logs');
    expect(commitCalled).toBe(true);
  });
});
