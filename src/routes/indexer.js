const express = require("express");
const eventStore = require("../indexer/eventStore");
const indexerPoller = require("../indexer/runtime");
const logger = require("../logger");
const AppError = require("../errors/AppError");
const buildRateLimit = require("../middleware/rateLimit");
const { validate } = require("../middleware/validate");
const {
  indexerAirdropParamsSchema,
  indexerRecipientParamsSchema,
  paginationQuerySchema,
} = require("../validation/schemas");
const { parsePagination, paginateResponse } = require("../utils/paginate");

const router = express.Router();
const validateAirdropParams = validate(indexerAirdropParamsSchema, "params");
const validateRecipientParams = validate(indexerRecipientParamsSchema, "params");
const validatePaginationQuery = validate(paginationQuerySchema, "query");

router.get("/airdrops/:id/status", validateAirdropParams, async (req, res, next) => {
  try {
    const { id } = req.validated.params;
    const status = await eventStore.getAirdropStatus(id);
    if (!status) {
      return next(
        new AppError("AIRDROP_NOT_INDEXED", "Airdrop has not been indexed", 404, {
          airdrop_id: id,
        })
      );
    }

    return res.json(status);
  } catch (err) {
    logger.error("Airdrop status lookup failed", { error: err.message });
    return next(err);
  }
});

router.get(
  "/airdrops/:id/onchain-recipients",
  validateAirdropParams,
  validatePaginationQuery,
  async (req, res, next) => {
    try {
      const { id } = req.validated.params;
      const allRecipients = await eventStore.getAirdropRecipients(id);
      const { page, limit } = parsePagination(req.query);
      const start = (page - 1) * limit;
      const pageRecipients = allRecipients.slice(start, start + limit);
      return res.json(paginateResponse(pageRecipients, allRecipients.length, { page, limit }));
    } catch (err) {
      logger.error("Airdrop recipients lookup failed", { error: err.message });
      return next(err);
    }
  }
);

router.get(
  "/recipients/:address/claims",
  validateRecipientParams,
  validatePaginationQuery,
  async (req, res, next) => {
    try {
      const { address } = req.validated.params;
      const allClaims = await eventStore.getRecipientClaims(address);
      const { page, limit } = parsePagination(req.query);
      const start = (page - 1) * limit;
      const pageClaims = allClaims.slice(start, start + limit);
      return res.json(paginateResponse(pageClaims, allClaims.length, { page, limit }));
    } catch (err) {
      logger.error("Recipient claims lookup failed", { error: err.message });
      return next(err);
    }
  }
);

const indexerStatusLimit = buildRateLimit({
  windowSeconds: 1,
  max: 1,
  keyPrefix: "indexer-status",
});

router.get("/indexer/status", indexerStatusLimit, async (_req, res, next) => {
  try {
    const stats = await eventStore.getStats();
    const poller = indexerPoller.getStatus();
    const hasLatestLedger = poller.latest_ledger !== null && poller.latest_ledger !== undefined;
    const latestLedger = Number(poller.latest_ledger);
    const lastLedger = Number(stats.last_ledger);
    const ledgerLag =
      hasLatestLedger && Number.isFinite(latestLedger) && Number.isFinite(lastLedger)
        ? Math.max(0, latestLedger - lastLedger)
        : null;

    return res.json({
      ...poller,
      last_ledger: stats.last_ledger,
      events_count: stats.events_count,
      lag: ledgerLag,
      ledger_lag: ledgerLag,
    });
  } catch (err) {
    logger.error("Indexer status lookup failed", { error: err.message });
    return next(err);
  }
});

module.exports = router;