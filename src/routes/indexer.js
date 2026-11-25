// #731 — Indexer recovery coordinator.
const INDEXER_RECOVERY_COOLDOWN_MS = 30_000;

let recoveryInFlight = null;
let lastRecoveryAt = 0;

const recoveryState = {
  attempts: 0,
  successes: 0,
  failures: 0,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  inProgress: false,
};

async function recoverIndexer(reason = 'unknown') {
  // Prevent concurrent recovery operations.
  if (recoveryInFlight) {
    return recoveryInFlight;
  }

  const now = Date.now();

  // Prevent recovery storms.
  if (now - lastRecoveryAt < INDEXER_RECOVERY_COOLDOWN_MS) {
    return {
      recovered: false,
      skipped: true,
      reason: 'recovery_cooldown',
    };
  }

  lastRecoveryAt = now;
  recoveryState.attempts += 1;
  recoveryState.lastAttemptAt = new Date(now).toISOString();
  recoveryState.inProgress = true;
  recoveryState.lastError = null;

  recoveryInFlight = (async () => {
    try {
      logger.warn('Indexer recovery initiated', { reason });

      /*
       * Runtime integration point.
       *
       * The runtime must implement this method and restore its cursor
       * from the last durable checkpoint before resuming polling.
       */
      if (typeof indexerPoller.retryFromLastCheckpoint !== 'function') {
        throw new Error(
          'Indexer runtime does not implement retryFromLastCheckpoint()',
        );
      }

      await indexerPoller.retryFromLastCheckpoint();

      recoveryState.successes += 1;
      recoveryState.lastSuccessAt = new Date().toISOString();

      logger.info('Indexer recovery completed', { reason });

      return {
        recovered: true,
        reason,
      };
    } catch (err) {
      recoveryState.failures += 1;
      recoveryState.lastFailureAt = new Date().toISOString();
      recoveryState.lastError = err.message;

      logger.error('Indexer recovery failed', {
        reason,
        error: err.message,
      });

      return {
        recovered: false,
        reason,
        error: err.message,
      };
    } finally {
      recoveryState.inProgress = false;
      recoveryInFlight = null;
    }
  })();

  return recoveryInFlight;
}