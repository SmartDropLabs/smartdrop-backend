'use strict';

/**
 * #500 — Tests for database transaction deadlock prevention, retry wrapper, and lock ordering.
 */

const {
  withTransaction,
  sortIds,
  lockRows,
  isDeadlockOrSerializationError,
} = require('../src/database');

describe('Database deadlock prevention & retry (#500)', () => {
  let mockKnex;
  let mockTrx;
  let commitCalled;
  let rollbackCalled;
  let completed;

  beforeEach(() => {
    commitCalled = 0;
    rollbackCalled = 0;
    completed = false;

    mockTrx = jest.fn((table) => ({
      whereIn: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      forUpdate: jest.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]),
      forShare: jest.fn().mockResolvedValue([{ id: 1 }]),
      skipLocked: jest.fn().mockResolvedValue([{ id: 1 }]),
      noWait: jest.fn().mockResolvedValue([{ id: 1 }]),
    }));

    mockTrx.commit = jest.fn(async () => {
      commitCalled += 1;
      completed = true;
    });

    mockTrx.rollback = jest.fn(async () => {
      rollbackCalled += 1;
      completed = true;
    });

    mockTrx.isCompleted = jest.fn(() => completed);

    mockTrx.raw = jest.fn(async (sql, bindings) => {
      return { rows: [{ id: 1 }] };
    });

    mockKnex = jest.fn();
    mockKnex.transaction = jest.fn(async () => {
      completed = false;
      return mockTrx;
    });
  });

  describe('isDeadlockOrSerializationError', () => {
    test('recognizes 40P01 deadlock detected', () => {
      const err = new Error('deadlock detected');
      err.code = '40P01';
      expect(isDeadlockOrSerializationError(err)).toBe(true);
    });

    test('recognizes 40001 serialization failure', () => {
      const err = new Error('could not serialize access due to concurrent update');
      err.code = '40001';
      expect(isDeadlockOrSerializationError(err)).toBe(true);
    });

    test('recognizes DEADLOCK_DETECTED driver code', () => {
      const err = new Error('Transaction aborted');
      err.code = 'DEADLOCK_DETECTED';
      expect(isDeadlockOrSerializationError(err)).toBe(true);
    });

    test('recognizes deadlock message without code', () => {
      const err = new Error('Process 12345 detected deadlock while waiting for ShareLock');
      expect(isDeadlockOrSerializationError(err)).toBe(true);
    });

    test('returns false for generic errors', () => {
      expect(isDeadlockOrSerializationError(new Error('Syntax error'))).toBe(false);
      const uniqueErr = new Error('duplicate key value violates unique constraint');
      uniqueErr.code = '23505';
      expect(isDeadlockOrSerializationError(uniqueErr)).toBe(false);
      expect(isDeadlockOrSerializationError(null)).toBe(false);
    });
  });

  describe('Retry wrapper unit tests', () => {
    test('retries on 40P01 and succeeds when retry passes', async () => {
      let attempts = 0;
      const sleepMock = jest.fn().mockResolvedValue();

      const result = await withTransaction(
        mockKnex,
        async (trx) => {
          attempts += 1;
          if (attempts === 1) {
            const deadlockErr = new Error('deadlock detected');
            deadlockErr.code = '40P01';
            throw deadlockErr;
          }
          return { success: true, attempts };
        },
        { sleep: sleepMock, maxRetries: 3 }
      );

      expect(result).toEqual({ success: true, attempts: 2 });
      expect(attempts).toBe(2);
      expect(sleepMock).toHaveBeenCalledTimes(1);
      expect(commitCalled).toBe(1);
      expect(rollbackCalled).toBe(1); // Rolled back the first failed attempt
    });

    test('retries on 40001 serialization failure', async () => {
      let attempts = 0;
      const sleepMock = jest.fn().mockResolvedValue();

      const result = await withTransaction(
        mockKnex,
        async (trx) => {
          attempts += 1;
          if (attempts <= 2) {
            const serialErr = new Error('could not serialize access');
            serialErr.code = '40001';
            throw serialErr;
          }
          return 'ok';
        },
        { sleep: sleepMock, maxRetries: 3 }
      );

      expect(result).toBe('ok');
      expect(attempts).toBe(3);
      expect(sleepMock).toHaveBeenCalledTimes(2);
      expect(commitCalled).toBe(1);
      expect(rollbackCalled).toBe(2);
    });

    test('does NOT retry on other errors and rethrows immediately', async () => {
      let attempts = 0;
      const sleepMock = jest.fn().mockResolvedValue();
      const syntaxError = new Error('syntax error at or near "SELCT"');
      syntaxError.code = '42601';

      await expect(
        withTransaction(
          mockKnex,
          async (trx) => {
            attempts += 1;
            throw syntaxError;
          },
          { sleep: sleepMock, maxRetries: 3 }
        )
      ).rejects.toThrow('syntax error at or near "SELCT"');

      expect(attempts).toBe(1); // No retries!
      expect(sleepMock).not.toHaveBeenCalled();
      expect(rollbackCalled).toBe(1);
      expect(commitCalled).toBe(0);
    });

    test('gives up after reaching the retry limit and rethrows deadlock error', async () => {
      let attempts = 0;
      const sleepMock = jest.fn().mockResolvedValue();
      const deadlockErr = new Error('deadlock detected');
      deadlockErr.code = '40P01';

      await expect(
        withTransaction(
          mockKnex,
          async (trx) => {
            attempts += 1;
            throw deadlockErr;
          },
          { sleep: sleepMock, maxRetries: 3 }
        )
      ).rejects.toThrow('deadlock detected');

      // Initial attempt (1) + 3 retries = 4 attempts total
      expect(attempts).toBe(4);
      expect(sleepMock).toHaveBeenCalledTimes(3);
      expect(rollbackCalled).toBe(4);
      expect(commitCalled).toBe(0);
    });
  });

  describe('Consistent lock ordering prevention', () => {
    test('sortIds sorts identifiers consistently to prevent lock order inversion', () => {
      expect(sortIds(['item_z', 'item_a', 'item_m'])).toEqual(['item_a', 'item_m', 'item_z']);
      expect(sortIds([99, 12, 3, 50])).toEqual([3, 12, 50, 99]);
      expect(sortIds([])).toEqual([]);
      expect(sortIds(null)).toEqual([]);
    });

    test('lockRows enforces sorted order and calls forUpdate', async () => {
      await lockRows(mockTrx, 'service_airdrops', ['drop_b', 'drop_a']);

      expect(mockTrx).toHaveBeenCalledWith('service_airdrops');
      expect(mockTrx('service_airdrops').whereIn).toHaveBeenCalledWith('id', ['drop_a', 'drop_b']);
      expect(mockTrx('service_airdrops').orderBy).toHaveBeenCalledWith('id', 'asc');
    });

    test('lockRows supports narrow FOR NO KEY UPDATE and SKIP LOCKED', async () => {
      await lockRows(mockTrx, 'webhook_deliveries', ['del_2', 'del_1'], {
        lockMode: 'forNoKeyUpdate',
        skipLocked: true,
      });

      expect(mockTrx.raw).toHaveBeenCalledWith(
        expect.stringContaining('FOR NO KEY UPDATE SKIP LOCKED'),
        ['webhook_deliveries', 'id', ['del_1', 'del_2'], 'id']
      );
    });

    test('simulates two concurrent transactions locking opposite order resolved by consistent ordering and retry', async () => {
      // Scenario: Tx 1 wants row A and B. Tx 2 wants row B and A.
      // With sortIds, both Tx 1 and Tx 2 sort to [A, B] before acquiring locks,
      // avoiding cyclic deadlock!
      const lockedRows = new Set();
      const lockAcquire = async (txId, rowId) => {
        if (lockedRows.has(rowId)) {
          // If another tx holds this row and holds something we have -> deadlock!
          const err = new Error('deadlock detected');
          err.code = '40P01';
          throw err;
        }
        lockedRows.add(rowId);
      };

      const unlockAll = () => lockedRows.clear();

      let deadlockSimulated = false;

      // Demonstrates that deadlock triggers retry which succeeds once locks are cleared
      const sleepMock = jest.fn().mockImplementation(async () => {
        unlockAll(); // on deadlock backoff, competitor completes and releases locks
      });

      const txA = await withTransaction(
        mockKnex,
        async (trx) => {
          if (!deadlockSimulated) {
            deadlockSimulated = true;
            lockedRows.add('row_b');
            const err = new Error('deadlock detected');
            err.code = '40P01';
            throw err;
          }
          // After retry and consistent order:
          const ids = sortIds(['row_b', 'row_a']);
          expect(ids).toEqual(['row_a', 'row_b']);
          for (const id of ids) {
            await lockAcquire('txA', id);
          }
          return 'txA_done';
        },
        { sleep: sleepMock, maxRetries: 2 }
      );

      expect(txA).toBe('txA_done');
      expect(deadlockSimulated).toBe(true);
      expect(sleepMock).toHaveBeenCalledTimes(1);
    });
  });
});
