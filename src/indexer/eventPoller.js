const { SorobanRpc } = require('stellar-sdk');
const config = require('../config');
const logger = require('../logger');
const eventStore = require('./eventStore');
const { parseContractEvent } = require('./eventParser');
const { CircuitBreaker } = require('../utils/circuitBreaker');

const RPC_MAX_RETRIES = 3;
const RPC_RETRY_BASE_MS = 1000;
// Ceiling on the adaptive poll interval (issue #255). Backing off further
// than this would leave the indexer effectively dormant long after a node
// recovered, since nothing re-probes sooner than the current interval.
const DEFAULT_MAX_POLL_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_BACKOFF_FACTOR = 2;
// Ledgers behind the chain tip before lag is treated as alertable. Stellar
// closes a ledger roughly every 5s, so 100 ledgers is ~8 minutes stale.
const DEFAULT_LAG_ALERT_THRESHOLD = 100;

class EventPoller {
  constructor(options = {}) {
    this.contractId = options.contractId ?? config.indexer.contractId;
    this.pollIntervalMs = options.pollIntervalMs ?? config.indexer.pollIntervalMs;
    this.pollLimit = options.pollLimit ?? config.indexer.pollLimit;
    this.startLedger = options.startLedger ?? config.indexer.startLedger;
    this.enabled = options.enabled ?? config.indexer.enabled;
    this.store = options.store || eventStore;
    this.logger = options.logger || logger;
    this.server = options.server || new SorobanRpc.Server(options.rpcUrl || config.stellar.sorobanRpcUrl);
    this.timer = null;
    this.stopped = false;
    this.lastRun = null;
    this.lastError = null;
    this.latestLedger = null;
    this.lastIndexedLedger = null;
    this.rpcBreaker = options.rpcBreaker || new CircuitBreaker('soroban-rpc', {
      failureThreshold: options.rpcFailureThreshold ?? 5,
      successThreshold: options.rpcSuccessThreshold ?? 1,
      timeoutMs: options.rpcCooldownMs ?? 60000,
    });

    // ── Adaptive polling (issue #255) ────────────────────────────────
    // The breaker stops individual RPC calls, but on its own the poller
    // still woke on a fixed interval and re-probed a struggling node at
    // full rate. Consecutive failures now stretch the interval
    // exponentially, and any success resets it to the configured base.
    this.basePollIntervalMs = this.pollIntervalMs;
    this.maxPollIntervalMs = options.maxPollIntervalMs
      ?? config.indexer.maxPollIntervalMs
      ?? DEFAULT_MAX_POLL_INTERVAL_MS;
    this.backoffFactor = options.backoffFactor
      ?? config.indexer.backoffFactor
      ?? DEFAULT_BACKOFF_FACTOR;
    this.consecutiveFailures = 0;
    this.currentPollIntervalMs = this.basePollIntervalMs;

    this.lagAlertThreshold = options.lagAlertThreshold
      ?? config.indexer.lagAlertThreshold
      ?? DEFAULT_LAG_ALERT_THRESHOLD;
    this.lagAlerting = false;

    this.metrics = {
      pollsAttempted: 0,
      pollsSucceeded: 0,
      pollsFailed: 0,
      pollsSkipped: 0,
      eventsIndexed: 0,
      startedAt: null,
    };
  }

  /**
   * Poll interval implied by the current consecutive-failure count.
   *
   * Exponential in the number of consecutive failures, clamped to
   * maxPollIntervalMs so a long outage cannot push the next attempt
   * arbitrarily far out.
   */
  computeBackoffMs() {
    if (this.consecutiveFailures === 0) return this.basePollIntervalMs;
    const scaled = this.basePollIntervalMs
      * this.backoffFactor ** this.consecutiveFailures;
    return Math.min(scaled, this.maxPollIntervalMs);
  }

  /** Ledgers behind the chain tip, or null when the tip is unknown. */
  getLag() {
    if (this.latestLedger == null || this.lastIndexedLedger == null) return null;
    return Math.max(0, Number(this.latestLedger) - Number(this.lastIndexedLedger));
  }

  getMetrics() {
    const { pollsAttempted, pollsSucceeded, pollsFailed, pollsSkipped, eventsIndexed, startedAt } = this.metrics;
    const elapsedSeconds = startedAt ? (Date.now() - startedAt) / 1000 : 0;
    const completed = pollsSucceeded + pollsFailed;
    return {
      polls_attempted: pollsAttempted,
      polls_succeeded: pollsSucceeded,
      polls_failed: pollsFailed,
      polls_skipped: pollsSkipped,
      events_indexed: eventsIndexed,
      // Rates are null rather than 0 before there is anything to divide by,
      // so "no data yet" is distinguishable from "genuinely zero".
      events_per_second: elapsedSeconds > 0
        ? Math.round((eventsIndexed / elapsedSeconds) * 1000) / 1000
        : null,
      error_rate: completed > 0
        ? Math.round((pollsFailed / completed) * 10000) / 10000
        : null,
      consecutive_failures: this.consecutiveFailures,
      current_poll_interval_ms: this.currentPollIntervalMs,
      base_poll_interval_ms: this.basePollIntervalMs,
    };
  }

  isConfigured() {
    return this.enabled && Boolean(this.contractId);
  }

  getStatus() {
    const lag = this.getLag();
    return {
      enabled: this.enabled,
      configured: this.isConfigured(),
      running: this.timer !== null,
      contract_id: this.contractId || null,
      poll_interval_ms: this.pollIntervalMs,
      poll_limit: this.pollLimit,
      last_run: this.lastRun,
      last_error: this.lastError,
      latest_ledger: this.latestLedger,
      // Circuit/backoff state (issue #255), so an operator can tell a
      // paused indexer from a healthy idle one.
      circuit_state: this.rpcBreaker.getState(),
      paused: this.rpcBreaker.isOpen(),
      consecutive_failures: this.consecutiveFailures,
      current_poll_interval_ms: this.currentPollIntervalMs,
      ledger_lag: lag,
      lag_alerting: lag !== null && lag > this.lagAlertThreshold,
      lag_alert_threshold: this.lagAlertThreshold,
      metrics: this.getMetrics(),
    };
  }

  async pollOnce() {
    if (!this.isConfigured()) {
      return { skipped: true, reason: 'SMARTDROP_CONTRACT_ID not configured' };
    }

    if (this.rpcBreaker.isOpen()) {
      // Pause rather than hammer an unreachable node (issue #255): the
      // breaker stays open for its cooldown, and the poll interval has
      // already been stretched by the failures that tripped it.
      this.metrics.pollsSkipped += 1;
      this.logger.warn('Soroban RPC circuit breaker open, pausing poll cycle', {
        consecutive_failures: this.consecutiveFailures,
        next_poll_interval_ms: this.currentPollIntervalMs,
      });
      return { skipped: true, reason: 'circuit breaker open', paused: true };
    }

    this.metrics.pollsAttempted += 1;

    const previousLedger = await this.store.getLastLedger(null);
    const startLedger = previousLedger == null
      ? this.startLedger || 0
      : Math.max(Number(previousLedger) + 1, this.startLedger || 0);

    let response;
    let lastError;
    for (let attempt = 1; attempt <= RPC_MAX_RETRIES; attempt++) {
      try {
        response = await this.rpcBreaker.call(() =>
          this.server.getEvents({
            startLedger,
            filters: [
              {
                type: 'contract',
                contractIds: [this.contractId],
              },
            ],
            limit: this.pollLimit,
          })
        );
        if (response !== null) break;
        lastError = new Error('RPC returned null (circuit breaker)');
      } catch (err) {
        lastError = err;
        if (attempt < RPC_MAX_RETRIES) {
          const delay = RPC_RETRY_BASE_MS * 2 ** (attempt - 1);
          this.logger.warn('Soroban RPC call failed, retrying', {
            attempt,
            maxRetries: RPC_MAX_RETRIES,
            delayMs: delay,
            error: err.message,
          });
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    if (!response) {
      throw lastError || new Error('Soroban RPC call failed after retries');
    }

    const rawEvents = response.events || [];
    const parsedEvents = rawEvents.map(parseContractEvent).filter(Boolean);

    for (const event of parsedEvents) {
      await this.store.saveEvent(event);
    }

    // response.latestLedger is the chain's current tip, not how far this
    // particular call actually got — if the RPC returned a full pollLimit
    // batch, more matching events may exist beyond it. Jumping the cursor
    // to the tip in that case permanently skips whatever wasn't returned,
    // with no retry and no downstream reconciliation that could recover
    // it (#115). Only safe to advance to the tip when this batch wasn't
    // truncated; otherwise advance only past what was actually processed,
    // so the next poll picks up right where this one left off.
    const truncated = rawEvents.length >= this.pollLimit;
    const eventLedgers = parsedEvents.map((event) => event.ledger);
    const latestIndexedLedger = truncated
      ? Math.max(previousLedger ?? 0, ...eventLedgers)
      : Math.max(response.latestLedger || previousLedger || 0, ...eventLedgers);

    await this.store.setLastLedger(latestIndexedLedger);
    this.lastIndexedLedger = latestIndexedLedger;
    this.metrics.eventsIndexed += parsedEvents.length;

    if (truncated) {
      this.logger.warn('SmartDrop event poll truncated by pollLimit; more events pending next cycle', {
        pollLimit: this.pollLimit,
        indexed_events: parsedEvents.length,
        resumed_from_ledger: latestIndexedLedger + 1,
      });
    }

    this.latestLedger = response.latestLedger || null;
    this.lastRun = new Date().toISOString();
    this.lastError = null;
    this.checkLag();

    return {
      skipped: false,
      start_ledger: startLedger,
      latest_ledger: response.latestLedger,
      indexed_events: parsedEvents.length,
      truncated,
      ledger_lag: this.getLag(),
    };
  }

  /**
   * Emits an alert when the indexer falls too far behind the chain tip,
   * and a matching recovery line when it catches back up (issue #255).
   *
   * Edge-triggered on purpose: a persistently lagging indexer would
   * otherwise log an identical warning on every single poll, burying the
   * moment the lag actually started.
   */
  checkLag() {
    const lag = this.getLag();
    if (lag === null) return;

    if (lag > this.lagAlertThreshold) {
      if (!this.lagAlerting) {
        this.lagAlerting = true;
        this.logger.error('Indexer lag exceeded threshold', {
          ledger_lag: lag,
          threshold: this.lagAlertThreshold,
          last_indexed_ledger: this.lastIndexedLedger,
          latest_ledger: this.latestLedger,
        });
      }
    } else if (this.lagAlerting) {
      this.lagAlerting = false;
      this.logger.info('Indexer lag recovered below threshold', {
        ledger_lag: lag,
        threshold: this.lagAlertThreshold,
      });
    }
  }

  /** Records a successful cycle: clears backoff and resets the interval. */
  recordPollSuccess() {
    this.metrics.pollsSucceeded += 1;
    if (this.consecutiveFailures > 0) {
      this.logger.info('Soroban RPC recovered, resetting poll interval', {
        after_consecutive_failures: this.consecutiveFailures,
        poll_interval_ms: this.basePollIntervalMs,
      });
    }
    this.consecutiveFailures = 0;
    this.currentPollIntervalMs = this.basePollIntervalMs;
  }

  /** Records a failed cycle and stretches the next poll interval. */
  recordPollFailure() {
    this.metrics.pollsFailed += 1;
    this.consecutiveFailures += 1;
    this.currentPollIntervalMs = this.computeBackoffMs();
  }

  start() {
    if (this.timer || !this.enabled) return;
    if (!this.contractId) {
      // Issue #217: fail fast — starting the indexer with no contract to
      // watch means every poll silently does nothing, which is a much
      // easier misconfiguration to miss than an explicit startup error.
      throw new Error('Cannot start SmartDrop indexer: SMARTDROP_CONTRACT_ID is not configured');
    }

    this.stopped = false;
    this.metrics.startedAt = Date.now();

    // A self-rescheduling timeout rather than setInterval: the delay before
    // the next cycle depends on how the last one went (issue #255), which a
    // fixed interval cannot express. It also guarantees cycles never
    // overlap, since the next one is only scheduled after this one settles.
    const run = async () => {
      try {
        const result = await this.pollOnce();
        if (result.skipped) {
          this.logger.debug('SmartDrop event poll skipped', result);
        } else {
          this.recordPollSuccess();
          this.logger.info('SmartDrop contract events indexed', result);
        }
      } catch (err) {
        this.lastRun = new Date().toISOString();
        this.lastError = err.message;
        this.recordPollFailure();
        this.logger.warn('SmartDrop event indexing failed', {
          error: err.message,
          consecutive_failures: this.consecutiveFailures,
          next_poll_interval_ms: this.currentPollIntervalMs,
        });
      } finally {
        this.scheduleNext(run);
      }
    };

    run();
    this.logger.info('SmartDrop event indexer started', {
      contractId: this.contractId,
      pollIntervalMs: this.pollIntervalMs,
      maxPollIntervalMs: this.maxPollIntervalMs,
      lagAlertThreshold: this.lagAlertThreshold,
    });
  }

  /**
   * Queues the next cycle at the current (possibly backed-off) interval.
   *
   * Checks `stopped` because a stop() that lands while a poll is in flight
   * would otherwise be undone by that poll's own finally block.
   */
  scheduleNext(run) {
    if (this.stopped) return;
    this.timer = setTimeout(run, this.currentPollIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.logger.info('SmartDrop event indexer stopped');
    }
  }
}

module.exports = { EventPoller };
