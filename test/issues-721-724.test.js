'use strict';

const EventEmitter = require('events');

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const {
  PoolMonitor,
  checkConnectionTimeout,
  DEFAULT_CONNECTION_TIMEOUT,
} = require('../src/database/poolMonitor');

const {
  QueryPlanCache,
  LRU,
  DEFAULT_MAX_ENTRIES,
  queryPlanCache,
} = require('../src/database/queryPlanCache');

const {
  ReadReplicaRouter,
  checkReplicationLag,
  MAX_LAG,
  DEFAULT_MAX_LAG,
} = require('../src/database/readReplicas');

const {
  withTransaction,
  transaction,
  ISOLATION_LEVELS,
  VALID_ISOLATION_LEVELS,
  normalizeIsolationLevel,
} = require('../src/database/transaction');

// ============================================================================
// Issue #721: database/poolMonitor.js - Connection timeout detection
// ============================================================================
describe('Issue #721: Connection timeout detection in poolMonitor.js', () => {
  let mockPool;
  let monitor;

  beforeEach(() => {
    mockPool = new EventEmitter();
    mockPool.min = 2;
    mockPool.max = 10;
    mockPool.used = 2;
    mockPool.free = 8;
    mockPool.numUsed = () => mockPool.used;
    mockPool.numFree = () => mockPool.free;
    mockPool.destroy = jest.fn();

    monitor = new PoolMonitor({ connectionTimeout: 30000 });
    monitor.attach(mockPool);
  });

  afterEach(() => {
    monitor.detach();
  });

  test('checkConnectionTimeout helper destroys connections older than timeout', () => {
    const fakeConn = {
      start: Date.now() - 35000,
      destroy: jest.fn(),
    };

    const timedOut = checkConnectionTimeout(fakeConn, 30000);
    expect(timedOut).toBe(true);
    expect(fakeConn.destroy).toHaveBeenCalledTimes(1);
  });

  test('checkConnectionTimeout does not destroy connection within timeout threshold', () => {
    const fakeConn = {
      start: Date.now() - 10000,
      destroy: jest.fn(),
    };

    const timedOut = checkConnectionTimeout(fakeConn, 30000);
    expect(timedOut).toBe(false);
    expect(fakeConn.destroy).not.toHaveBeenCalled();
  });

  test('PoolMonitor detects and destroys timed out active connections', () => {
    const conn1 = {
      __cid: 'c1',
      start: Date.now() - 40000,
      destroy: jest.fn(),
    };
    const conn2 = {
      __cid: 'c2',
      start: Date.now() - 5000,
      destroy: jest.fn(),
    };

    mockPool.emit('acquireRequest', 1);
    mockPool.emit('acquireSuccess', 1, conn1);

    mockPool.emit('acquireRequest', 2);
    mockPool.emit('acquireSuccess', 2, conn2);

    expect(monitor._activeConnections.size).toBe(2);

    const timedOut = monitor.checkTimeouts(30000);
    expect(timedOut.length).toBe(1);
    expect(conn1.destroy).toHaveBeenCalledTimes(1);
    expect(conn2.destroy).not.toHaveBeenCalled();
    expect(monitor.counters.timeouts).toBe(1);
    expect(monitor._activeConnections.size).toBe(1);
  });

  test('releases remove connection from active tracking so timeout is not triggered', () => {
    const conn = {
      __cid: 'c3',
      start: Date.now() - 40000,
      destroy: jest.fn(),
    };

    mockPool.emit('acquireRequest', 3);
    mockPool.emit('acquireSuccess', 3, conn);
    expect(monitor._activeConnections.has('c3')).toBe(true);

    mockPool.emit('release', conn);
    expect(monitor._activeConnections.has('c3')).toBe(false);

    const timedOut = monitor.checkTimeouts(30000);
    expect(timedOut.length).toBe(0);
    expect(conn.destroy).not.toHaveBeenCalled();
  });

  test('includes timeout metric in Prometheus exposition output', () => {
    monitor.counters.timeouts = 3;
    const metricsText = monitor.toPrometheusMetrics();

    expect(metricsText).toContain('# HELP db_pool_timeouts_total Total connection timeouts detected');
    expect(metricsText).toContain('# TYPE db_pool_timeouts_total counter');
    expect(metricsText).toContain('db_pool_timeouts_total 3');
  });
});

// ============================================================================
// Issue #722: database/queryPlanCache.js - Query plan cache size limit
// ============================================================================
describe('Issue #722: Query plan cache size limit and LRU eviction', () => {
  test('LRU cache evicts oldest entry when size limit is exceeded', () => {
    const lru = new LRU({ max: 3 });

    lru.set('q1', 'plan1');
    lru.set('q2', 'plan2');
    lru.set('q3', 'plan3');

    expect(lru.size).toBe(3);
    expect(lru.get('q1')).toBe('plan1');

    // Accessing q1 moves it to most recently used. Oldest is now q2.
    // Adding q4 should evict q2.
    lru.set('q4', 'plan4');

    expect(lru.size).toBe(3);
    expect(lru.has('q2')).toBe(false);
    expect(lru.get('q1')).toBe('plan1');
    expect(lru.get('q3')).toBe('plan3');
    expect(lru.get('q4')).toBe('plan4');
  });

  test('QueryPlanCache respects max size limit', () => {
    const cache = new QueryPlanCache({ max: 2 });

    cache.set('SELECT 1', [], { cost: 10 });
    cache.set('SELECT 2', [], { cost: 20 });
    expect(cache.getStats().size).toBe(2);

    // Access SELECT 1 so SELECT 2 becomes LRU
    cache.get('SELECT 1', []);

    // Inserting 3rd query plan evicts SELECT 2
    cache.set('SELECT 3', [], { cost: 30 });
    expect(cache.getStats().size).toBe(2);

    expect(cache.get('SELECT 2', [])).toBeNull();
    expect(cache.get('SELECT 1', [])).toEqual({ cost: 10 });
    expect(cache.get('SELECT 3', [])).toEqual({ cost: 30 });
  });

  test('default cache instance has DEFAULT_MAX_ENTRIES of 1000', () => {
    expect(DEFAULT_MAX_ENTRIES).toBe(1000);
    expect(queryPlanCache.maxEntries).toBe(1000);
    expect(queryPlanCache.cache.max).toBe(1000);
  });

  test('clear and invalidate operations work with LRU-backed cache', () => {
    const cache = new QueryPlanCache({ max: 10 });
    cache.set('SELECT 1', [1], { cost: 5 });
    cache.set('SELECT 2', [2], { cost: 15 });

    expect(cache.get('SELECT 1', [1])).toEqual({ cost: 5 });
    cache.invalidate('SELECT 1', [1]);
    expect(cache.get('SELECT 1', [1])).toBeNull();

    cache.clear();
    expect(cache.getStats().size).toBe(0);
    expect(cache.getStats().hits).toBe(0);
    expect(cache.getStats().misses).toBe(0);
  });
});

// ============================================================================
// Issue #723: database/readReplicas.js - Replica lag detection
// ============================================================================
describe('Issue #723: Replica lag detection in readReplicas.js', () => {
  let mockReplica1;
  let mockReplica2;
  let mockPrimary;
  let router;

  beforeEach(() => {
    mockPrimary = {
      raw: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
      destroy: jest.fn(),
    };

    mockReplica1 = {
      raw: jest.fn().mockResolvedValue({ rows: [{ lag: 2 }] }), // 2 seconds lag
      destroy: jest.fn(),
    };

    mockReplica2 = {
      raw: jest.fn().mockResolvedValue({ rows: [{ lag: 45 }] }), // 45 seconds lag (> 30s threshold)
      destroy: jest.fn(),
    };

    router = new ReadReplicaRouter({
      primary: 'postgres://primary:5432/db',
      replicas: ['postgres://rep1:5432/db', 'postgres://rep2:5432/db'],
      maxLag: 30,
    });

    router.primary = mockPrimary;
    router.replicas = [mockReplica1, mockReplica2];
  });

  afterEach(async () => {
    await router.destroy();
  });

  test('checkReplicationLag calculates lag in seconds from database query', async () => {
    const fakeReplica = {
      raw: jest.fn().mockResolvedValue({ rows: [{ lag: 4.5 }] }),
    };

    const lag = await checkReplicationLag(fakeReplica);
    expect(lag).toBe(4.5);
    expect(fakeReplica.raw).toHaveBeenCalledWith(
      expect.stringContaining('pg_last_xact_replay_timestamp()')
    );
  });

  test('checkReplicaHealth marks replica unhealthy when lag exceeds maxLag', async () => {
    // Replica 1 has 2s lag (healthy)
    mockReplica1.raw = jest.fn().mockImplementation((query) => {
      if (query === 'select 1') return Promise.resolve({ rows: [{ 1: 1 }] });
      return Promise.resolve({ rows: [{ lag: 2 }] });
    });

    // Replica 2 has 45s lag (exceeds maxLag 30s)
    mockReplica2.raw = jest.fn().mockImplementation((query) => {
      if (query === 'select 1') return Promise.resolve({ rows: [{ 1: 1 }] });
      return Promise.resolve({ rows: [{ lag: 45 }] });
    });

    const health = await router.checkReplicaHealth();

    expect(health).toEqual([true, false]);
    expect(router.isHealthy(mockReplica1)).toBe(true);
    expect(router.isHealthy(mockReplica2)).toBe(false);
  });

  test('routing skips unhealthy lagging replica and selects healthy replica', async () => {
    router.markReplicaUnhealthy(mockReplica2);

    const chosen1 = router.getReplica();
    const chosen2 = router.getReplica();

    expect(chosen1).toBe(mockReplica1);
    expect(chosen2).toBe(mockReplica1);
  });

  test('marks replica healthy again when lag recovers below threshold', async () => {
    router.markReplicaUnhealthy(mockReplica2);
    expect(router.isHealthy(mockReplica2)).toBe(false);

    // Lag dropped to 1s
    mockReplica2.raw = jest.fn().mockImplementation((query) => {
      if (query === 'select 1') return Promise.resolve({ rows: [{ 1: 1 }] });
      return Promise.resolve({ rows: [{ lag: 1 }] });
    });

    await router.checkReplicaHealth();
    expect(router.isHealthy(mockReplica2)).toBe(true);
  });

  test('markUnhealthy and markHealthy aliases work correctly', () => {
    expect(router.isHealthy(mockReplica1)).toBe(true);
    router.markUnhealthy(mockReplica1);
    expect(router.isHealthy(mockReplica1)).toBe(false);
    router.markHealthy(mockReplica1);
    expect(router.isHealthy(mockReplica1)).toBe(true);
  });
});

// ============================================================================
// Issue #724: database/transaction.js - Transaction isolation level config
// ============================================================================
describe('Issue #724: Transaction isolation level configuration in transaction.js', () => {
  let mockKnex;
  let mockTrx;
  let receivedConfig;

  beforeEach(() => {
    receivedConfig = null;

    mockTrx = jest.fn();
    mockTrx.commit = jest.fn(async () => {});
    mockTrx.rollback = jest.fn(async () => {});
    mockTrx.isCompleted = jest.fn(() => false);

    mockKnex = jest.fn();
    mockKnex.transaction = jest.fn(async (config) => {
      receivedConfig = config;
      return mockTrx;
    });
  });

  test('normalizeIsolationLevel standardizes uppercase levels to lowercase', () => {
    expect(normalizeIsolationLevel('READ COMMITTED')).toBe('read committed');
    expect(normalizeIsolationLevel('REPEATABLE READ')).toBe('repeatable read');
    expect(normalizeIsolationLevel('SERIALIZABLE')).toBe('serializable');
    expect(normalizeIsolationLevel('READ UNCOMMITTED')).toBe('read uncommitted');
    expect(normalizeIsolationLevel('SNAPSHOT')).toBe('snapshot');
    expect(normalizeIsolationLevel(undefined)).toBeUndefined();
  });

  test('normalizeIsolationLevel throws on invalid isolation levels', () => {
    expect(() => normalizeIsolationLevel('DIRTY READ')).toThrow('Invalid isolationLevel');
    expect(() => normalizeIsolationLevel('CHAOS')).toThrow('Invalid isolationLevel');
  });

  test('withTransaction configures isolationLevel on transaction options', async () => {
    await withTransaction(
      mockKnex,
      async (trx) => {
        expect(trx).toBe(mockTrx);
        return 'success';
      },
      { isolationLevel: 'READ COMMITTED' }
    );

    expect(mockKnex.transaction).toHaveBeenCalledTimes(1);
    expect(receivedConfig).toEqual({ isolationLevel: 'read committed' });
    expect(mockTrx.commit).toHaveBeenCalled();
  });

  test('withTransaction supports lowercase and uppercase isolation level names', async () => {
    await withTransaction(
      mockKnex,
      async () => 'ok',
      { isolationLevel: 'SERIALIZABLE' }
    );
    expect(receivedConfig).toEqual({ isolationLevel: 'serializable' });

    await withTransaction(
      mockKnex,
      async () => 'ok',
      { isolationLevel: 'repeatable read' }
    );
    expect(receivedConfig).toEqual({ isolationLevel: 'repeatable read' });
  });

  test('transaction wrapper function forwards isolation level configuration', async () => {
    await transaction(
      mockKnex,
      async (trx) => {
        expect(trx).toBe(mockTrx);
        return 42;
      },
      { isolationLevel: 'READ COMMITTED' }
    );

    expect(mockKnex.transaction).toHaveBeenCalledTimes(1);
    expect(receivedConfig).toEqual({ isolationLevel: 'read committed' });
  });

  test('ISOLATION_LEVELS constant defines all standard levels', () => {
    expect(ISOLATION_LEVELS.READ_COMMITTED).toBe('read committed');
    expect(ISOLATION_LEVELS.REPEATABLE_READ).toBe('repeatable read');
    expect(ISOLATION_LEVELS.SERIALIZABLE).toBe('serializable');
    expect(ISOLATION_LEVELS.READ_UNCOMMITTED).toBe('read uncommitted');
  });
});
