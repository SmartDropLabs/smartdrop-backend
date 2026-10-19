'use strict';

const EventEmitter = require('events');
const { PoolMonitor, defaultPoolMonitor } = require('../src/database/poolMonitor');
const { getPoolStats, getPoolMetrics, setDb } = require('../src/database');

// Mock pool with EventEmitter
class MockTarnPool extends EventEmitter {
  constructor(options = {}) {
    super();
    this.min = options.min ?? 2;
    this.max = options.max ?? 10;
    this.used = options.used ?? 0;
    this.free = options.free ?? 2;
    this.pendingAcquires = options.pendingAcquires ?? 0;
    this.pendingCreates = options.pendingCreates ?? 0;
  }

  numUsed() {
    return this.used;
  }

  numFree() {
    return this.free;
  }

  numPendingAcquires() {
    return this.pendingAcquires;
  }

  numPendingCreates() {
    return this.pendingCreates;
  }
}

describe('Database Connection Pool Monitoring (#520)', () => {
  let mockPool;
  let monitor;

  beforeEach(() => {
    mockPool = new MockTarnPool({ min: 2, max: 10, used: 2, free: 8 });
    monitor = new PoolMonitor();
    monitor.attach(mockPool);
  });

  afterEach(() => {
    monitor.detach();
  });

  describe('Event Tracking & Counters', () => {
    test('tracks acquire request, success, and release lifecycle', () => {
      expect(monitor.counters.acquireRequests).toBe(0);
      expect(monitor.counters.acquireSuccesses).toBe(0);
      expect(monitor.counters.releases).toBe(0);

      // Acquire start
      mockPool.emit('acquireRequest', 1);
      expect(monitor.counters.acquireRequests).toBe(1);

      // Acquire success
      mockPool.used = 3;
      mockPool.free = 7;
      mockPool.emit('acquireSuccess', 1, {});
      expect(monitor.counters.acquireSuccesses).toBe(1);

      // Release
      mockPool.used = 2;
      mockPool.free = 8;
      mockPool.emit('release', {});
      expect(monitor.counters.releases).toBe(1);
    });

    test('tracks connection creation and failure', () => {
      mockPool.emit('createRequest', 101);
      expect(monitor.counters.createRequests).toBe(1);

      mockPool.emit('createSuccess', 101, {});
      expect(monitor.counters.createSuccesses).toBe(1);

      const error = new Error('Connection refused: 5432');
      mockPool.emit('createFail', 102, error);
      expect(monitor.counters.createFailures).toBe(1);
      expect(monitor.lastFailure).toMatchObject({
        type: 'createFail',
        error: 'Connection refused: 5432',
      });
    });

    test('tracks acquire failure and updates status', () => {
      mockPool.emit('acquireRequest', 201);
      const timeoutErr = new Error('Knex: Timeout acquiring a connection');
      mockPool.emit('acquireFail', 201, timeoutErr);

      expect(monitor.counters.acquireFailures).toBe(1);
      expect(monitor.lastFailure).toMatchObject({
        type: 'acquireFail',
        error: 'Knex: Timeout acquiring a connection',
      });

      const metrics = monitor.getMetrics();
      expect(metrics.status).toBe('critical');
    });
  });

  describe('Utilization & Health Status', () => {
    test('calculates correct utilization ratio', () => {
      mockPool.used = 5;
      mockPool.max = 10;
      const snapshot = monitor.getSnapshot();

      expect(snapshot.used).toBe(5);
      expect(snapshot.max).toBe(10);
      expect(snapshot.utilization).toBe(0.5);
      expect(snapshot.status).toBe('healthy');
    });

    test('transitions to warning when utilization >= 80%', () => {
      mockPool.used = 8;
      mockPool.max = 10;
      const snapshot = monitor.getSnapshot();

      expect(snapshot.utilization).toBe(0.8);
      expect(snapshot.status).toBe('warning');
    });

    test('transitions to critical when utilization >= 95%', () => {
      mockPool.used = 10;
      mockPool.max = 10;
      const snapshot = monitor.getSnapshot();

      expect(snapshot.utilization).toBe(1.0);
      expect(snapshot.status).toBe('critical');
    });

    test('triggers warning and critical callbacks when thresholds exceeded', () => {
      const onWarning = jest.fn();
      const onCritical = jest.fn();

      const alertMonitor = new PoolMonitor({
        warningThreshold: 0.7,
        criticalThreshold: 0.9,
        onWarning,
        onCritical,
      });
      alertMonitor.attach(mockPool);

      // Exceed warning
      mockPool.used = 7;
      mockPool.max = 10;
      mockPool.emit('acquireRequest', 1);
      mockPool.emit('acquireSuccess', 1, {});
      expect(onWarning).toHaveBeenCalledTimes(1);

      // Exceed critical
      mockPool.used = 9;
      mockPool.emit('acquireRequest', 2);
      mockPool.emit('acquireSuccess', 2, {});
      expect(onCritical).toHaveBeenCalledTimes(1);

      alertMonitor.detach();
    });
  });

  describe('Prometheus Metrics Formatting', () => {
    test('formats metrics according to standard Prometheus text specification', () => {
      mockPool.used = 3;
      mockPool.max = 10;
      mockPool.free = 7;
      mockPool.pendingAcquires = 1;

      mockPool.emit('acquireRequest', 1);
      mockPool.emit('acquireSuccess', 1, {});

      const prometheusText = monitor.toPrometheusMetrics();

      expect(prometheusText).toContain('# HELP db_pool_connections_used Connections currently acquired from pool');
      expect(prometheusText).toContain('# TYPE db_pool_connections_used gauge');
      expect(prometheusText).toContain('db_pool_connections_used 3');
      expect(prometheusText).toContain('db_pool_connections_max 10');
      expect(prometheusText).toContain('db_pool_connections_free 7');
      expect(prometheusText).toContain('db_pool_connections_utilization 0.3');
      expect(prometheusText).toContain('db_pool_acquires_total 1');
      expect(prometheusText).toContain('db_pool_acquire_successes_total 1');
    });
  });

  describe('Integration with Database Index API', () => {
    test('getPoolStats and getPoolMetrics reflect active pool state', () => {
      const mockKnex = {
        client: {
          pool: mockPool,
        },
      };

      setDb(mockKnex);

      const stats = getPoolStats();
      expect(stats).toMatchObject({
        min: 2,
        max: 10,
        used: 2,
        free: 8,
        status: 'healthy',
      });

      const metrics = getPoolMetrics();
      expect(metrics).toHaveProperty('counters');
      expect(metrics).toHaveProperty('timing');
      expect(metrics).toHaveProperty('status');

      setDb(null);
    });
  });
});
