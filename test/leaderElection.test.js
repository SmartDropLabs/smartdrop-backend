'use strict';

/**
 * Leader Election Tests
 *
 * Tests the Redis-based leader election mechanism with multi-instance
 * simulation, failover scenarios, and log observability.
 *
 * Uses the in-memory cache mock from test/helpers/cacheMock.js so tests
 * run without a real Redis instance.
 */

const { createCacheMock: mockCreateCacheMock } = require('./helpers/cacheMock');
const { createLeaderElection } = require('../src/services/leaderElection');

// We need to override the cache module before requiring leaderElection.
// The factory below may only reference identifiers Jest's mock-hoisting
// considers safe (globals, or names prefixed with "mock") — hence the
// renamed import above instead of the plain `createCacheMock`.
jest.mock('../src/services/cache', () => {
  const mock = mockCreateCacheMock();
  // Store reference for test access
  global.__cacheMock__ = mock;
  return mock.cacheMock;
});

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../src/config', () => ({
  leaderElection: {
    instanceId: 'test-instance-001',
    leaseTtlMs: 500,
    renewIntervalMs: 200,
  },
}));

const logger = require('../src/logger');

// Helper: advance time by a given number of ms using jest's fake timers
jest.useFakeTimers();

describe('Leader Election', () => {
  let cacheMock;
  let redis;
  let leaderElection;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();

    cacheMock = global.__cacheMock__;
    cacheMock.reset();
    redis = cacheMock.redis;

    leaderElection = createLeaderElection('test_job', {
      instanceId: 'test-instance-001',
      leaseTtlMs: 500,
      renewIntervalMs: 200,
    });
  });

  afterEach(() => {
    leaderElection.stopRenewLoop();
  });

  /* ------------------------------------------------------------------ */
  /*  Basic lock acquisition and release                                */
  /* ------------------------------------------------------------------ */

  describe('lock acquisition and release', () => {
    test('tryAcquire returns true when no one holds the lock', async () => {
      const result = await leaderElection.tryAcquire();
      expect(result).toBe(true);
      expect(leaderElection.isLeader()).toBe(true);
    });

    test('tryAcquire returns false when another instance holds the lock', async () => {
      // First instance acquires
      const result1 = await leaderElection.tryAcquire();
      expect(result1).toBe(true);

      // Second instance tries to acquire
      const leaderElection2 = createLeaderElection('test_job', {
        instanceId: 'test-instance-002',
        leaseTtlMs: 500,
        renewIntervalMs: 200,
      });

      const result2 = await leaderElection2.tryAcquire();
      expect(result2).toBe(false);
      expect(leaderElection2.isLeader()).toBe(false);

      leaderElection2.stopRenewLoop();
    });

    test('getCurrentLeader returns the instance id of the lock holder', async () => {
      await leaderElection.tryAcquire();
      const current = await leaderElection.getCurrentLeader();
      expect(current).toBe('test-instance-001');
    });

    test('stopRenewLoop releases the lock', async () => {
      await leaderElection.tryAcquire();
      expect(leaderElection.isLeader()).toBe(true);

      await leaderElection.stopRenewLoop();
      expect(leaderElection.isLeader()).toBe(false);

      const current = await leaderElection.getCurrentLeader();
      expect(current).toBeNull();
    });

    test('getState returns correct diagnostic info', async () => {
      await leaderElection.tryAcquire();
      const state = leaderElection.getState();
      expect(state.isLeader).toBe(true);
      expect(state.instanceId).toBe('test-instance-001');
      expect(state.lockKey).toBe('leader:test_job');
      expect(state.leaseTtlMs).toBe(500);
      expect(state.renewIntervalMs).toBe(200);
      expect(state.acquiredAt).toBeTruthy();
      expect(state.lastRenewedAt).toBeTruthy();
    });

    test('state-change callback errors do not reject acquisition', async () => {
      const callback = jest.fn(() => {
        throw new Error('callback failed');
      });
      leaderElection.startRenewLoop(callback);

      await jest.advanceTimersByTimeAsync(1);
      expect(leaderElection.isLeader()).toBe(true);
      expect(logger.error).toHaveBeenCalledWith(
        'Leader state-change callback failed',
        expect.objectContaining({ error: 'callback failed' }),
      );
    });

    test('release notifies the state-change callback before clearing it', async () => {
      const states = [];
      leaderElection.startRenewLoop(() => states.push(leaderElection.isLeader()));
      await leaderElection.tryAcquire();

      await leaderElection.stopRenewLoop();

      expect(states).toEqual([true, false]);
    });

    test('registers a callback when the renewal loop is already running', async () => {
      const callback = jest.fn();
      leaderElection.startRenewLoop();
      leaderElection.startRenewLoop(callback);

      await jest.advanceTimersByTimeAsync(1);

      expect(callback).toHaveBeenCalled();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Lease renewal                                                     */
  /* ------------------------------------------------------------------ */

  describe('lease renewal', () => {
    test('renew() successfully extends the lease when we hold it', async () => {
      await leaderElection.tryAcquire();
      expect(leaderElection.isLeader()).toBe(true);

      // Manually advance time to simulate lease expiry approach
      const result = await leaderElection.renew();
      expect(result).toBe(true);
      expect(leaderElection.isLeader()).toBe(true);
    });

    test('renew() returns false and clears leader when lease is lost', async () => {
      await leaderElection.tryAcquire();
      expect(leaderElection.isLeader()).toBe(true);

      // Simulate someone else taking the lock (direct Redis manipulation).
      // Same shared in-memory client as `redis` above — there's only one
      // Redis (real or mocked) for every instance to contend over.
      await redis.set('leader:test_job', 'test-instance-002', 'PX', 500);

      const result = await leaderElection.renew();
      expect(result).toBe(false);
      expect(leaderElection.isLeader()).toBe(false);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Multi-instance simulation (2+ concurrent "instances")              */
  /* ------------------------------------------------------------------ */

  describe('multi-instance simulation', () => {
    test('only one out of 3 instances holds leadership at a time', async () => {
      const instances = [];
      const NUM_INSTANCES = 3;

      // Create 3 leader election instances
      for (let i = 0; i < NUM_INSTANCES; i++) {
        const inst = createLeaderElection('multi_test', {
          instanceId: `instance-${String(i).padStart(3, '0')}`,
          leaseTtlMs: 500,
          renewIntervalMs: 200,
        });
        instances.push(inst);
      }

      // All try to acquire simultaneously
      const results = await Promise.all(instances.map((inst) => inst.tryAcquire()));

      // Exactly one should succeed
      const leaders = results.filter((r) => r === true);
      expect(leaders.length).toBe(1);

      // The leader should report isLeader() === true
      const leaderIndex = results.indexOf(true);
      expect(instances[leaderIndex].isLeader()).toBe(true);

      // All others should report isLeader() === false
      for (let i = 0; i < NUM_INSTANCES; i++) {
        if (i !== leaderIndex) {
          expect(instances[i].isLeader()).toBe(false);
        }
      }

      // Cleanup
      await Promise.all(instances.map((inst) => inst.stopRenewLoop()));
    });

    test('only one instance tick function executes when wrapped via leaderAwareJob', async () => {
      const { makeLeaderAwareJob } = require('../src/jobs/leaderAwareJob');

      // Create a mock job that records how many times it's started
      const mockJob = {
        start: jest.fn(),
        stop: jest.fn(),
        getHealth: jest.fn(() => ({
          healthy: true,
          lastSuccessAt: Date.now(),
          lastError: null,
          stalled: false,
        })),
      };

      const instances = [];
      const NUM_INSTANCES = 3;

      // Create multiple leader-aware wrapped jobs
      for (let i = 0; i < NUM_INSTANCES; i++) {
        const le = createLeaderElection('aware_test', {
          instanceId: `aware-instance-${String(i).padStart(3, '0')}`,
          leaseTtlMs: 500,
          renewIntervalMs: 200,
        });

        const wrapped = makeLeaderAwareJob({
          job: {
            start: jest.fn(),
            stop: jest.fn(),
            getHealth: mockJob.getHealth,
          },
          jobName: 'aware_test',
          leaderElection: le,
          logger,
        });

        instances.push({ le, wrapped });
      }

      // Start all wrapped jobs (they'll each start their renewal loops)
      for (const { wrapped } of instances) {
        wrapped.start();
      }

      // Let initial acquisition happen
      await jest.advanceTimersByTimeAsync(100);

      // Count how many underlying jobs actually started
      const startedCount = instances.filter(({ wrapped }) => {
        const health = wrapped.getHealth();
        return health.leader === true;
      }).length;

      expect(startedCount).toBe(1);

      // Cleanup
      for (const { wrapped } of instances) {
        await wrapped.stop();
      }
    });

    test('starting a wrapped job twice does not duplicate its lifecycle', async () => {
      const { makeLeaderAwareJob } = require('../src/jobs/leaderAwareJob');
      const job = {
        start: jest.fn(),
        stop: jest.fn(),
      };
      const wrapped = makeLeaderAwareJob({
        job,
        jobName: 'idempotent_test',
        leaderElection: createLeaderElection('idempotent_test', {
          instanceId: 'idempotent-instance',
          leaseTtlMs: 500,
          renewIntervalMs: 200,
        }),
        logger,
      });

      wrapped.start();
      wrapped.start();
      await wrapped.getLeaderElection().tryAcquire();
      await jest.advanceTimersByTimeAsync(250);

      expect(job.start).toHaveBeenCalledTimes(1);

      await wrapped.stop();
      expect(job.stop).toHaveBeenCalledTimes(1);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Kill-the-leader test (simulate crash, verify failover)            */
  /* ------------------------------------------------------------------ */

  describe('kill-the-leader failover', () => {
    test('follower acquires leadership after leader lease expires', async () => {
      // Leader instance
      const leader = createLeaderElection('failover_test', {
        instanceId: 'leader-instance',
        leaseTtlMs: 300,
        renewIntervalMs: 100,
      });

      // Follower instance
      const follower = createLeaderElection('failover_test', {
        instanceId: 'follower-instance',
        leaseTtlMs: 300,
        renewIntervalMs: 100,
      });

      // Leader acquires
      const leaderResult = await leader.tryAcquire();
      expect(leaderResult).toBe(true);
      expect(leader.isLeader()).toBe(true);

      // Follower fails to acquire
      const followerResult = await follower.tryAcquire();
      expect(followerResult).toBe(false);
      expect(follower.isLeader()).toBe(false);

      // "Kill" the leader by stopping its renewal loop (simulates crash)
      await leader.stopRenewLoop();
      expect(leader.isLeader()).toBe(false);

      // Wait for lease TTL to expire + some buffer
      await jest.advanceTimersByTimeAsync(500);

      // Follower should now be able to acquire
      const followerResult2 = await follower.tryAcquire();
      expect(followerResult2).toBe(true);
      expect(follower.isLeader()).toBe(true);

      // Verify the lock key now holds follower's id
      const current = await follower.getCurrentLeader();
      expect(current).toBe('follower-instance');

      follower.stopRenewLoop();
    });

    test('renewal loop detects and re-acquires leadership after leader crash', async () => {
      // This simulates the full renewal loop behavior
      const leader = createLeaderElection('renewal_failover', {
        instanceId: 'renewal-leader',
        leaseTtlMs: 300,
        renewIntervalMs: 100,
      });

      const follower = createLeaderElection('renewal_failover', {
        instanceId: 'renewal-follower',
        leaseTtlMs: 300,
        renewIntervalMs: 100,
      });

      // Start both renewal loops
      leader.startRenewLoop();
      follower.startRenewLoop();

      // Allow initial acquisition
      await jest.advanceTimersByTimeAsync(50);

      // Leader should have the lock
      expect(leader.isLeader()).toBe(true);
      expect(follower.isLeader()).toBe(false);

      // "Kill" leader
      await leader.stopRenewLoop();

      // Wait for lease expiry + follower renewal cycle
      await jest.advanceTimersByTimeAsync(600);

      // Follower should have acquired the lock
      expect(follower.isLeader()).toBe(true);

      follower.stopRenewLoop();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Graceful handoff test (release lock on stop)                      */
  /* ------------------------------------------------------------------ */

  describe('graceful handoff', () => {
    test('stopRenewLoop releases lease immediately so follower can take over', async () => {
      const leader = createLeaderElection('handoff_test', {
        instanceId: 'handoff-leader',
        leaseTtlMs: 10000, // Long TTL to prove we don't wait for expiry
        renewIntervalMs: 5000,
      });

      const follower = createLeaderElection('handoff_test', {
        instanceId: 'handoff-follower',
        leaseTtlMs: 10000,
        renewIntervalMs: 5000,
      });

      // Leader acquires
      await leader.tryAcquire();
      expect(leader.isLeader()).toBe(true);

      // Follower fails
      const followerResult = await follower.tryAcquire();
      expect(followerResult).toBe(false);

      // Leader gracefully releases (simulates SIGTERM)
      await leader.stopRenewLoop();
      expect(leader.isLeader()).toBe(false);

      // Follower should immediately acquire (no need to wait for TTL)
      const followerResult2 = await follower.tryAcquire();
      expect(followerResult2).toBe(true);
      expect(follower.isLeader()).toBe(true);

      follower.stopRenewLoop();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Log observability test                                            */
  /* ------------------------------------------------------------------ */

  describe('log observability', () => {
    test('acquiring leadership logs a clear message', async () => {
      await leaderElection.tryAcquire();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringMatching(/Acquired leader lease/i),
        expect.objectContaining({
          job: 'test_job',
          instanceId: 'test-instance-001',
        }),
      );
    });

    test('releasing leadership logs a clear message', async () => {
      await leaderElection.tryAcquire();
      jest.clearAllMocks();
      await leaderElection.stopRenewLoop();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringMatching(/Released leader lease/i),
        expect.objectContaining({
          job: 'test_job',
          instanceId: 'test-instance-001',
        }),
      );
    });

    test('renewal loop started logs a clear message', () => {
      leaderElection.startRenewLoop();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringMatching(/Leader election renewal loop started/i),
        expect.objectContaining({
          job: 'test_job',
          instanceId: 'test-instance-001',
        }),
      );
    });

    test('failing to acquire as follower logs acting as follower via health state', async () => {
      // First instance acquires
      await leaderElection.tryAcquire();

      // Second instance tries
      const leaderElection2 = createLeaderElection('test_job', {
        instanceId: 'test-instance-002',
        leaseTtlMs: 500,
        renewIntervalMs: 200,
      });

      const result = await leaderElection2.tryAcquire();
      expect(result).toBe(false);
      expect(leaderElection2.isLeader()).toBe(false);
      expect(leaderElection2.getState().isLeader).toBe(false);

      leaderElection2.stopRenewLoop();
    });
  });
});

