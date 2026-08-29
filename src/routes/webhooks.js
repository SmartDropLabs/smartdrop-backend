"use strict";

const express = require("express");
const config = require("../config");
const { validate } = require("../middleware/validate");
const webhookRepo = require("../repositories/webhookRepository");
const deliveryRepo = require("../repositories/deliveryRepository");
const dispatcher = require("../services/webhookDispatcher");
const signatureService = require("../services/webhookSignature");
const { probeReachability } = require("../services/webhook");
const { idempotencyMiddleware } = require("../services/idempotency");
const buildRateLimit = require("../middleware/rateLimit");
const { routeTimeout } = require("../middleware/timeout");
const AppError = require("../errors/AppError");
const { paginateResponse } = require("../utils/paginate");
const {
  paginationQuerySchema,
  routeIdParamsSchema,
  webhookCreateBodySchema,
  webhookDeliveriesQuerySchema,
  webhookPatchBodySchema,
} = require("../validation/schemas");

const router = express.Router();
router.use(express.json({ limit: config.webhooks.jsonMaxBytes }));
const validateRouteIdParams = validate(routeIdParamsSchema, "params");
const validatePaginationQuery = validate(paginationQuerySchema, "query");

const manageLimit = buildRateLimit({
  windowSeconds: config.webhooks.rateLimit.windowSeconds,
  max: config.webhooks.rateLimit.max,
  keyPrefix: "webhooks",
});

const testLimit = buildRateLimit({
  windowSeconds: config.webhooks.testRateLimit.windowSeconds,
  max: config.webhooks.testRateLimit.max,
  keyPrefix: "webhooks_test",
});

function clientIpFromRequest(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor
      .split(",")[0]
      .trim()
      .replace(/^::ffff:/, "");
  }
  if (Array.isArray(forwardedFor) && forwardedFor[0]) {
    return String(forwardedFor[0])
      .trim()
      .replace(/^::ffff:/, "");
  }
  return (req.ip || req.socket?.remoteAddress || "unknown").replace(
    /^::ffff:/,
    "",
  );
}

router.use("/webhooks", manageLimit);

router.get("/webhooks/metrics", async (req, res) => {
  return res.json(dispatcher.getMetrics());
});

/**
 * Map a raw delivery error string to a coarse, non-leaky category for the
 * externally-visible test-endpoint response. The raw low-level network error
 * (ECONNREFUSED/ETIMEDOUT/ECONNRESET, etc.) is kept in server-side logs but
 * must not be echoed back to the caller, since it is exactly what makes the
 * test endpoint a useful internal-network reconnaissance oracle (see #96).
 */
function deliveryErrorCategory(rawError) {
  if (!rawError) return null;
  const msg = String(rawError);
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ECONNABORTED|socket hang up|network error/i.test(msg)) {
    return 'unreachable';
  }
  if (/^HTTP \d+/.test(msg)) return 'error_response';
  return 'delivery_failed';
}

function publicView(webhook) {
  if (!webhook) return null;
  return {
    id: webhook.id,
    url: webhook.url,
    events: webhook.events,
    filters: webhook.filters,
    active: webhook.active,
    description: webhook.description,
    created_at: webhook.created_at,
    updated_at: webhook.updated_at,
    secret_preview: webhook.secret ? `${webhook.secret.slice(0, 10)}…` : null,
  };
}

router.post(
  "/webhooks",
  routeTimeout(),
  idempotencyMiddleware("webhook"),
  validate(webhookCreateBodySchema),
  async (req, res, next) => {
    try {
      const body = req.validated.body;
      const ownerIp = clientIpFromRequest(req);
      const existingCount = await webhookRepo.countByOwner(ownerIp);
      if (existingCount >= config.webhooks.maxPerSubscriber) {
        // Distinct from RATE_LIMITED: this is a standing quota on how many
        // webhooks a subscriber may own, not a request rate. Waiting and
        // retrying will never clear it — the client must delete a webhook.
        // owner_ip is deliberately not echoed back in the response details.
        return next(
          new AppError(
            "WEBHOOK_LIMIT_EXCEEDED",
            `Webhook limit of ${config.webhooks.maxPerSubscriber} per subscriber exceeded`,
            429,
            { limit: config.webhooks.maxPerSubscriber, current: existingCount },
          ),
        );
      }

      const secret = body.secret || signatureService.generateSecret();
      const reachability = await probeReachability(body.url);
      const webhook = await webhookRepo.create({
        url: body.url,
        events: body.events,
        secret,
        description: body.description,
        filters: body.filters,
        owner_ip: ownerIp,
      });

      const response = {
        ...publicView(webhook),
        secret,
        secret_warning:
          "Store this secret now — it will not be shown again in plaintext.",
        reachability: reachability.reachable ? "reachable" : "unreachable",
      };

      if (!reachability.reachable) {
        response.warning = `Webhook target is unreachable during registration: ${reachability.error || "request failed"}`;
      }

      return res.status(201).json(response);
    } catch (err) {
      return next(err);
    }
  },
);

router.get("/webhooks", validatePaginationQuery, async (req, res, next) => {
  try {
    const { page, limit } = req.validated.query;
    const result = await webhookRepo.list(page, limit);
    return res.json(
      paginateResponse(result.webhooks.map(publicView), result.total, {
        page,
        limit,
      }),
    );
  } catch (err) {
    return next(err);
  }
});

router.get("/webhooks/:id", validateRouteIdParams, async (req, res, next) => {
  try {
    const webhook = await webhookRepo.findById(req.params.id);
    if (!webhook)
      return next(new AppError("WEBHOOK_NOT_FOUND", "Webhook not found", 404));
    return res.json(publicView(webhook));
  } catch (err) {
    return next(err);
  }
});

router.patch(
  "/webhooks/:id",
  validateRouteIdParams,
  validate(webhookPatchBodySchema),
  async (req, res, next) => {
    try {
      const patch = req.validated.body;
      const updated = await webhookRepo.update(req.params.id, patch);
      if (!updated)
        return next(
          new AppError("WEBHOOK_NOT_FOUND", "Webhook not found", 404),
        );
      return res.json(publicView(updated));
    } catch (err) {
      return next(err);
    }
  },
);

router.delete(
  "/webhooks/:id",
  validateRouteIdParams,
  async (req, res, next) => {
    try {
      const deleted = await webhookRepo.remove(req.params.id);
      if (!deleted)
        return next(
          new AppError("WEBHOOK_NOT_FOUND", "Webhook not found", 404),
        );
      return res.json({ deleted: true, id: req.params.id });
    } catch (err) {
      return next(err);
    }
  },
);

router.post(
  "/webhooks/:id/test",
  routeTimeout(),
  validateRouteIdParams,
  testLimit,
  async (req, res, next) => {
    try {
      const delivery = await dispatcher.sendTest(req.params.id);
      if (!delivery)
        return next(
          new AppError("WEBHOOK_NOT_FOUND", "Webhook not found", 404),
        );
      return res.status(202).json({
        delivery_id: delivery.id,
        status: delivery.status,
        attempts: delivery.attempts,
        response_status: delivery.response_status,
        last_error: delivery.last_error,
      });
    } catch (err) {
      return next(err);
    }
  },
);

router.get(
  "/webhooks/:id/deliveries",
  validateRouteIdParams,
  validate(webhookDeliveriesQuerySchema, "query"),
  async (req, res, next) => {
    try {
      const webhook = await webhookRepo.findById(req.params.id);
      if (!webhook)
        return next(
          new AppError("WEBHOOK_NOT_FOUND", "Webhook not found", 404),
        );
      const { limit, status } = req.validated.query;
      const deliveries = await deliveryRepo.listByWebhook(req.params.id, {
        limit,
        status,
      });
      return res.json({ deliveries });
    } catch (err) {
      return next(err);
    }
  },
);

module.exports = router;
