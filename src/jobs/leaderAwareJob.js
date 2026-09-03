'use strict';

/**
 * Leader-aware job wrapper.
 *
 * Wraps a job module (e.g. priceRefresh, webhookRetryWorker, airdropExpiry)
 * with leader-election coordination so that the underlying job's scheduled
 * work only actually executes on the instance that currently holds the
 * Redis-based leader lease.
 *
 * Non-leader instances remain ready to take over if the current leader's
 * lease expires. Leadership state transitions are logged clearly for
 * debugging in production.
 *
 * Usage:
 *   const leaderElection = require('../services/leaderElection');
 *   const priceRefreshJob = require('./priceRefresh');
 *   const wrappedJob = makeLeaderAwareJob({
 *     job: priceRefreshJob,
 *     jobName: 'price_refresh',
 *     leaderElection: leaderElection.createLeaderElection('price_refresh'),
 *     logger: require('../logger'),
 *   });
 *   wrappedJob.start();  // only starts underlying job if leader
 *   wrappedJob.stop();   // stops underlying job and releases lease
 *   wrappedJob.getHealth(); // includes leadership info
 */

function makeLeaderAwareJob({ job, jobName, leaderElection, logger }) {
  let underlyingStarted = false;
  let manualStop = false;
  let leadershipLostWhileRunning = false;
  let started = false;
  let checkInterval = null;
  let stopPromise = null;
  let restartAfterStop = false;

  // Capture the true originals once at construction so start()/stop() cycles
  // never layer wrappers on top of previous wrappers (#119).
  const trueTryAcquire = leaderElection.tryAcquire.bind(leaderElection);
  const trueRenew = leaderElection.renew.bind(leaderElection);
  const trueStartRenewLoop = leaderElection.startRenewLoop.bind(leaderElection);
  const trueStopRenewLoop = leaderElection.stopRenewLoop.bind(leaderElection);

  /**
   * Handle acquiring leadership: start the underlying job.
   */
  function onLeadershipAcquired() {
    if (manualStop) return;
    if (!underlyingStarted) {
      logger.info('Acting as leader — starting scheduled job', { job: jobName });
      job.start();
      underlyingStarted = true;
    } else if (leadershipLostWhileRunning) {
      // We lost leadership briefly and regained it — the underlying job was
      // stopped when we lost it, so restart it.
      logger.info('Re-acquired leadership — restarting scheduled job', { job: jobName });
      job.start();
      leadershipLostWhileRunning = false;
    }
  }

  /**
   * Handle losing leadership: stop the underlying job immediately.
   */
  function onLeadershipLost() {
    if (underlyingStarted) {
      logger.warn('Lost leadership — stopping scheduled job', { job: jobName });
      job.stop();
      underlyingStarted = false;
      leadershipLostWhileRunning = true;
    }
  }

  /**
   * Start the leader-election renewal loop.
   *
   * The underlying job's actual execution (cron / setInterval) is only
   * started when this instance acquires the leader lease. Non-leader
   * instances run only the renewal loop, staying ready to take over.
   */
  function start() {
    if (started) return;
    if (stopPromise) {
      restartAfterStop = true;
      return;
    }

    started = true;
    manualStop = false;
    leadershipLostWhileRunning = false;

    let wasLeader = false;

    const checkLeader = () => {
      const isLeaderNow = leaderElection.isLeader();
      if (isLeaderNow && !wasLeader) {
        onLeadershipAcquired();
      } else if (!isLeaderNow && wasLeader) {
        onLeadershipLost();
      }
      wasLeader = isLeaderNow;
    };

    // Check leadership state independently of the election loop's internals.
    checkInterval = setInterval(() => {
      checkLeader();
    }, Math.min(leaderElection.renewIntervalMs || 5000, 2000));

    if (typeof checkInterval.unref === 'function') {
      checkInterval.unref();
    }

    leaderElection.startRenewLoop(checkLeader);
    logger.info('Leader-aware job started — awaiting leadership', {
      job: jobName,
      instanceId: leaderElection.instanceId,
    });
  }

  /**
   * Stop the leader-election loop and restore original methods so a
   * subsequent start() wraps from a clean baseline (#119).
   */
  async function stop() {
    if (stopPromise) return stopPromise;

    manualStop = true;
    stopPromise = (async () => {
      if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
      }
      // Release the lease and stop the renewal loop before resetting state.
      await leaderElection.stopRenewLoop();

      if (underlyingStarted) {
        job.stop();
        underlyingStarted = false;
      }

      started = false;
      logger.info('Leader-aware job stopped', { job: jobName });
    })().finally(() => {
      stopPromise = null;
      if (restartAfterStop) {
        restartAfterStop = false;
        start();
      }
    });

    return stopPromise;
  }

  /**
   * Returns health info including leadership status.
   */
  function getHealth() {
    const baseHealth = typeof job.getHealth === 'function' ? job.getHealth() : {};
    const leaderState = leaderElection.getState();

    return {
      ...baseHealth,
      leader: leaderState.isLeader,
      leaderInstanceId: leaderState.instanceId,
      leaderSince: leaderState.acquiredAt,
      lockKey: leaderState.lockKey,
    };
  }

  /**
   * Get the underlying leader election instance (useful for tests).
   */
  function getLeaderElection() {
    return leaderElection;
  }

  return {
    start,
    stop,
    getHealth,
    getLeaderElection,
    jobName,
    underlyingJob: job,
  };
}

module.exports = { makeLeaderAwareJob };

