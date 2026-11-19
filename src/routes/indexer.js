const express = require('express');
const eventStore = require('../indexer/eventStore');
const indexerPoller = require('../indexer/runtime');
const cache = require('../services/cache');
const logger = require('../logger');
const AppError = require('../errors/AppError');
const buildRateLimit = require('../middleware/rateLimit');
const { parsePagination, paginateResponse } = require('../utils/paginate');
const { validate } = require('../middleware/validate');
const {
  indexerAirdropIdParamsSchema,
  indexerAddressParamsSchema,
  paginationQuerySchema,
} = require('../validation/schemas');

const router = express.Router();

const validateAirdropId = validate(indexerAirdropIdParamsSchema, 'params');
const validateAddress = validate(indexerAddressParamsSchema, 'params');
const validatePagination = validate(paginationQuerySchema, 'query');

// Indexer progress snapshot (issue #673). Written to the cache on every status
// read so other processes and dashboards can see how far the indexer has got
// without recomputing it, and read back by GET /indexer/progress.
const INDEXER_PROGRESS_CACHE_KEY = 'indexer:progress';
const INDEXER_PROGRESS_TTL_SECONDS = 300;

/**
 * Builds the indexing progress snapshot from the event store stats and the
 * poller status. `lastBlock` is the last indexed ledger, `totalBlocks` is the
 * chain tip the indexer is working towards, and `percentage` is how far along
 * it is. Any value that cannot be determined yet is null rather than 0.
 */
function buildIndexerProgress(stats, poller) {
  const hasCurrent = stats.last_ledger !== null && stats.last_ledger !== undefined;
  const hasTarget = poller.latest_ledger !== null && poller.latest_ledger !== undefined;
  const currentBlock = Number(stats.last_ledger);
  const targetBlock = Number(poller.latest_ledger);
  const canCompute = hasCurrent && hasTarget
    && Number.isFinite(currentBlock) && Number.isFinite(targetBlock) && targetBlock > 0;

  const percentage = canCompute
    ? Math.min(100, Math.max(0, Math.round((currentBlock / targetBlock) * 10000) / 100))
    : null;

  return {
    lastBlock: hasCurrent && Number.isFinite(currentBlock) ? currentBlock : null,
    totalBlocks: hasTarget && Number.isFinite(targetBlock) ? targetBlock : null,
    percentage,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Stores the progress snapshot in the cache. Fire-and-forget from the request
 * path: a cache failure must not fail the status response.
 */
function persistIndexerProgress(progress) {
  cache.set(INDEXER_PROGRESS_CACHE_KEY, progress, INDEXER_PROGRESS_TTL_SECONDS)
    .catch((err) => {
      logger.warn('Failed to cache indexer progress', { error: err.message });
    });
}

router.get('/airdrops/:id/status', validateAirdropId, async (req, res, next) => {
  try {
    const status = await eventStore.getAirdropStatus(req.params.id);
    if (!status) {
      return next(new AppError('AIRDROP_NOT_INDEXED', 'Airdrop has not been indexed', 404, {
        airdrop_id: req.params.id,
      }));
    }

    return res.json(status);
  } catch (err) {
    logger.error('Airdrop status lookup failed', { error: err.message });
    return next(err);
  }
});

// Named distinctly from airdrops.js's own `/airdrops/:id/recipients` (the
// stored/intended recipient list): this returns recipients derived from
// indexed on-chain claim events, a different source of truth. The two
// routers previously registered the exact same path, and since this
// router is mounted first in src/index.js, it silently shadowed the real
// listRecipients handler in airdrops.js on every request.
// getAirdropRecipients/getRecipientClaims below fully materialize their
// list from a single Redis key regardless (see eventStore.js's
// getJsonList) — there's no server-side "fetch only a page" available at
// the storage layer, so pagination here is a slice of the already-fetched
// array plus the canonical envelope, not a more efficient query (#131).
router.get('/airdrops/:id/onchain-recipients', validateAirdropId, validatePagination, async (req, res, next) => {
  try {
    const allRecipients = await eventStore.getAirdropRecipients(req.params.id);
    const { page, limit } = req.validated.query;
    const start = (page - 1) * limit;
    const pageRecipients = allRecipients.slice(start, start + limit);
    return res.json(paginateResponse(pageRecipients, allRecipients.length, { page, limit }));
  } catch (err) {
    logger.error('Airdrop recipients lookup failed', { error: err.message });
    return next(err);
  }
});

router.get('/recipients/:address/claims', validateAddress, validatePagination, async (req, res, next) => {
  try {
    const { address } = req.validated.params;
    const allClaims = await eventStore.getRecipientClaims(address);
    const { page, limit } = req.validated.query;
    const start = (page - 1) * limit;
    const pageClaims = allClaims.slice(start, start + limit);
    return res.json(paginateResponse(pageClaims, allClaims.length, { page, limit }));
  } catch (err) {
    logger.error('Recipient claims lookup failed', { error: err.message });
    return next(err);
  }
});

const indexerStatusLimit = buildRateLimit({
  windowSeconds: 1,
  max: 1,
  keyPrefix: 'indexer-status',
});

router.get('/indexer/status', indexerStatusLimit, async (_req, res, next) => {
  try {
    const stats = await eventStore.getStats();
    const poller = indexerPoller.getStatus();
    const hasLatestLedger = poller.latest_ledger !== null && poller.latest_ledger !== undefined;
    const latestLedger = Number(poller.latest_ledger);
    const lastLedger = Number(stats.last_ledger);
    const ledgerLag = hasLatestLedger && Number.isFinite(latestLedger) && Number.isFinite(lastLedger)
      ? Math.max(0, latestLedger - lastLedger)
      : null;

    const progress = buildIndexerProgress(stats, poller);
    persistIndexerProgress(progress);

    return res.json({
      ...poller,
      last_ledger: stats.last_ledger,
      events_count: stats.events_count,
      lag: ledgerLag,
      ledger_lag: ledgerLag,
      progress,
    });
  } catch (err) {
    logger.error('Indexer status lookup failed', { error: err.message });
    return next(err);
  }
});

router.get('/indexer/progress', async (_req, res, next) => {
  try {
    let progress = null;
    try {
      progress = await cache.get(INDEXER_PROGRESS_CACHE_KEY);
    } catch (err) {
      logger.warn('Indexer progress cache read failed', { error: err.message });
    }

    if (!progress) {
      const stats = await eventStore.getStats();
      const poller = indexerPoller.getStatus();
      progress = buildIndexerProgress(stats, poller);
      persistIndexerProgress(progress);
    }

    return res.json(progress);
  } catch (err) {
    logger.error('Indexer progress lookup failed', { error: err.message });
    return next(err);
  }
});

module.exports = router;
