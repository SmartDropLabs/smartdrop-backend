'use strict';

const cron = require('node-cron');
const airdropsService = require('../services/airdrops');
const webhookDispatcher = require('../services/webhookDispatcher');
const config = require('../config');
const logger = require('../logger');

let scheduledTask = null;

/**
 * One reconciliation pass: scans every non-terminal airdrop and expires any
 * whose expiry_ledger has passed the current Horizon ledger. Exported
 * separately from start() so tests can drive a single tick deterministically
 * instead of waiting on cron.
 */
async function tick() {
  let currentLedger;
  try {
    currentLedger = await airdropsService.getCurrentLedger();
  } catch (err) {
    // Matches priceOracle.js's graceful-degradation style: Horizon being
    // temporarily unreachable is expected and recoverable — log and skip
    // this cycle rather than crashing the job or throwing out of the cron
    // callback.
    logger.warn('Airdrop expiry check skipped, Horizon unreachable', { error: err.message });
    return;
  }

  let expiredCount = 0;
  let scannedCount = 0;

  for await (const batch of airdropsService.scanIds()) {
    for (const id of batch) {
      scannedCount += 1;

      let airdrop;
      try {
        airdrop = await airdropsService.get(id);
      } catch (err) {
        logger.error('Airdrop expiry check failed to read airdrop, skipping', {
          airdrop_id: id,
          error: err.message,
        });
        continue;
      }

      if (!airdrop || airdropsService.TERMINAL_STATUSES.has(airdrop.status)) continue;
      if (!airdrop.expiry_ledger || airdrop.expiry_ledger > currentLedger) continue;

      // Cheap pre-filter above avoids an unnecessary Lua round trip for the
      // (typically vast majority of) airdrops nowhere near expiry.
      // markExpired re-checks status and expiry_ledger atomically — if this
      // pre-filter read was stale, or another cycle/process already
      // transitioned it, markExpired safely no-ops instead of double-firing.
      let updated;
      try {
        updated = await airdropsService.markExpired(id, currentLedger);
      } catch (err) {
        logger.error('Airdrop expiry transition failed, skipping', {
          airdrop_id: id,
          error: err.message,
        });
        continue;
      }
      if (!updated) continue;

      expiredCount += 1;
      try {
        await webhookDispatcher.dispatch({
          event_type: 'airdrop.failed',
          event_id: `evt_airdrop_expired_${id}_${currentLedger}`,
          data: {
            airdrop_id: id,
            reason: 'expired',
            expiry_ledger: updated.expiry_ledger,
            current_ledger: currentLedger,
          },
        });
      } catch (err) {
        // The transition already committed — the airdrop is correctly
        // expired regardless of whether the webhook delivery attempt
        // itself failed to enqueue. Losing this specific delivery on a
        // dispatch-time error (as opposed to an individual subscriber's
        // endpoint failing, which webhookDispatcher already retries) is an
        // accepted gap here — see #84 for the broader non-atomic-writes
        // theme this falls under.
        logger.error('Airdrop expiry webhook dispatch failed', {
          airdrop_id: id,
          error: err.message,
        });
      }
    }
  }

  logger.info('Airdrop expiry check completed', {
    currentLedger,
    scanned: scannedCount,
    expired: expiredCount,
  });
}

function start() {
  if (scheduledTask) return;

  const intervalSeconds = config.airdrops.expiryCheckIntervalSeconds;
  const cronExpression = `*/${intervalSeconds} * * * * *`;

  scheduledTask = cron.schedule(
    cronExpression,
    () => {
      tick().catch((err) => {
        logger.error('Airdrop expiry check failed', { error: err.message });
      });
    },
    { scheduled: true },
  );

  logger.info('Airdrop expiry job started', { intervalSeconds });
}

function stop() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    logger.info('Airdrop expiry job stopped');
  }
}

module.exports = { start, stop, tick };
