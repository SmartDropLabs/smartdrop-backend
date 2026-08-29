"use strict";

const { z } = require("zod");
const webhookEvents = require("../services/webhookEvents");
const config = require("../config");

const stellarPublicKeySchema = z
  .string()
  .regex(/^G[A-Z0-9]{55}$/, "Must be a valid Stellar public key");

const { toStroops, sumStroops, stroopsEqual } = require("../utils/stroops");

const assetCodeSchema = z
  .string()
  .trim()
  .min(1, "Asset code is required")
  .max(12, "Asset code must be 12 characters or fewer")
  .regex(/^[A-Za-z0-9]+$/, "Asset code must be alphanumeric")
  .transform((value) => value.toUpperCase());

const optionalIssuerSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  stellarPublicKeySchema.optional(),
);

const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const routeIdParamsSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(
      /^[A-Za-z0-9_-]+$/,
      "ID can contain only letters, numbers, underscores, and hyphens",
    ),
});

// Ranges that must never be reachable from an operator-supplied URL — hitting
// them lets an attacker use this server as a relay into the internal network.
const PRIVATE_HOSTNAME_RE = /^(localhost|.*\.local)(:\d+)?$/i;

const PRIVATE_IP_RE = new RegExp(
  "^(" +
    "127\\." + // loopback
    "|10\\." + // RFC-1918 /8
    "|172\\.(1[6-9]|2\\d|3[01])\\." + // RFC-1918 /12
    "|192\\.168\\." + // RFC-1918 /16
    "|169\\.254\\." + // link-local
    "|0\\.0\\.0\\.0" + // unspecified
    "|::1" + // IPv6 loopback
    "|fc[0-9a-f]{2}:" + // IPv6 ULA
    ")",
);

function isPrivateTarget(hostname) {
  return PRIVATE_HOSTNAME_RE.test(hostname) || PRIVATE_IP_RE.test(hostname);
}

const CONTROL_CHAR_RE = /[\x00-\x08\x0E-\x1F\x7F]/;

const httpUrlSchema = z
  .string()
  .trim()
  .refine((value) => !CONTROL_CHAR_RE.test(value), {
    message: "URL must not contain control characters",
  })
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol);
      } catch {
        return false;
      }
    },
    {
      message: "Must be an http(s) URL",
    },
  )
  .refine(
    (value) => {
      try {
        const { hostname } = new URL(value);
        return !isPrivateTarget(hostname);
      } catch {
        return false;
      }
    },
    {
      message: "URL must not target a private or internal network address",
    },
  );

const priceParamsSchema = z.object({
  asset_code: assetCodeSchema,
});

const priceQuerySchema = z.object({
  issuer: optionalIssuerSchema,
});

const keyCreateBodySchema = z.object({
  label: z.string().trim().min(1).max(80),
  scopes: z.array(z.string().trim().min(1)).nonempty().optional(),
  // Sizes the key's own rate limit bucket (issue #251). Enumerated from
  // configuration so adding a tier does not require touching validation.
  tier: z.enum(Object.keys(config.apiKeyRateLimit.tiers)).optional(),
});

const keyRotateBodySchema = z.object({
  // Preserves label and scopes from the old key, but allows overriding tier
  tier: z.enum(Object.keys(config.apiKeyRateLimit.tiers)).optional(),
});

const alertCreateBodySchema = z.object({
  asset: assetCodeSchema.refine(
    (code) =>
      config.watchedAssets.length === 0 || config.watchedAssets.includes(code),
    { message: "Asset code is not in the list of watched Stellar assets" },
  ),
  type: z.enum(["above", "below", "change_pct"]),
  threshold_usd: z.number().positive(),
  webhook_url: httpUrlSchema,
  webhook_secret: z.string().min(8),
  repeat: z.boolean().optional(),
});

const webhookSubscriptionSchema = z
  .array(z.string().trim())
  .nonempty()
  .refine((value) => webhookEvents.isValidSubscription(value))
  .superRefine((events, ctx) => {
    if (events.length === 1 && events[0] === webhookEvents.WILDCARD) {
      return;
    }
    if (events.includes(webhookEvents.WILDCARD)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Wildcard "${webhookEvents.WILDCARD}" cannot be mixed with explicit event types`,
      });
      return;
    }
    if (events.length > webhookEvents.MAX_EXPLICIT_SUBSCRIPTIONS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Too many explicit subscriptions (max ${webhookEvents.MAX_EXPLICIT_SUBSCRIPTIONS})`,
      });
      return;
    }
    const invalidEvents = events.filter((e) => !webhookEvents.isKnownEvent(e));
    if (invalidEvents.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown event type(s): ${invalidEvents.join(", ")}. Valid events are: ${webhookEvents.ALL_EVENTS.join(", ")}`,
      });
    }
  });

const webhookFiltersSchema = z
  .object({
    asset: z
      .string()
      .trim()
      .min(1)
      .max(12)
      .regex(/^[A-Za-z0-9]+$/, "Asset filter must be alphanumeric")
      .transform((value) => value.toUpperCase())
      .optional(),
    pool_id: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
  .refine((value) => value.asset !== undefined || value.pool_id !== undefined, {
    message: "At least one filter must be provided",
  });

const webhookCreateBodySchema = z.object({
  url: httpUrlSchema,
  events: webhookSubscriptionSchema,
  secret: z.string().min(16).optional(),
  description: z.string().optional(),
  filters: webhookFiltersSchema.optional(),
});

const webhookPatchBodySchema = z.object({
  url: httpUrlSchema.optional(),
  events: webhookSubscriptionSchema.optional(),
  secret: z.string().min(16).optional(),
  active: z.boolean().optional(),
  description: z.string().optional(),
  filters: webhookFiltersSchema.optional(),
});

const webhookDeliveriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(["pending", "success", "failed"]).optional(),
});

// Stellar Int64 max in stroops, divided by 10_000_000 to get max in whole units
// that can be safely represented as a JS number
const MAX_AMOUNT_UNITS = Number(9223372036854775807n / 10000000n);

const recipientSchema = z.object({
  address: stellarPublicKeySchema,
  amount: z
    .number()
    .positive()
    .max(MAX_AMOUNT_UNITS, "amount exceeds Stellar Int64 ceiling")
    .refine((v) => Number.isFinite(v), "amount must be a finite number")
    .refine((v) => {
      const str = String(v);
      const dotIndex = str.indexOf(".");
      return dotIndex === -1 || str.length - dotIndex - 1 <= 7;
    }, "amount must have at most 7 decimal places"),
});

const recipientsSchema = z
  .array(recipientSchema)
  .max(10000, "recipients cannot exceed 10,000")
  .superRefine((recipients, ctx) => {
    const seen = new Set();
    recipients.forEach((recipient, index) => {
      if (seen.has(recipient.address)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "address"],
          message: `recipient ${index}: duplicate address ${recipient.address}`,
        });
      }
      seen.add(recipient.address);
    });
  });

function expiryLedgerSchema(currentLedger) {
  return z
    .number()
    .int()
    .gt(
      currentLedger,
      `expiry_ledger must be greater than current ledger (${currentLedger})`,
    );
}

function airdropCreateBodySchema(currentLedger) {
  return z
    .object({
      name: z.string().trim().min(1),
      description: z.string().optional(),
      asset: assetCodeSchema,
      asset_issuer: stellarPublicKeySchema,
      total_amount: z
        .number()
        .positive()
        .max(MAX_AMOUNT_UNITS, `total_amount exceeds Stellar Int64 ceiling`),
      expiry_ledger: expiryLedgerSchema(currentLedger),
      recipients: recipientsSchema.optional().default([]),
    })
    .superRefine((body, ctx) => {
      if (body.recipients.length === 0) return;

      try {
        const totalStroops = sumStroops(body.recipients);
        const expectedStroops = toStroops(body.total_amount);
        if (totalStroops !== expectedStroops) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["recipients"],
            message: `sum of recipient amounts must equal total_amount (${body.total_amount})`,
          });
        }
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["recipients"],
          message: err.message,
        });
      }
    });
}

function airdropUpdateBodySchema(currentLedger) {
  return z.object({
    name: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    expiry_ledger: expiryLedgerSchema(currentLedger).optional(),
  });
}

const airdropRecipientsBodySchema = z.object({
  recipients: z.preprocess((value) => {
    if (typeof value !== "string") return value;

    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }, recipientsSchema.optional()),
});

module.exports = {
  airdropCreateBodySchema,
  airdropRecipientsBodySchema,
  airdropUpdateBodySchema,
  alertCreateBodySchema,
  assetCodeSchema,
  httpUrlSchema,
  keyCreateBodySchema,
  keyRotateBodySchema,
  optionalIssuerSchema,
  paginationQuerySchema,
  priceParamsSchema,
  priceQuerySchema,
  recipientsSchema,
  routeIdParamsSchema,
  stellarPublicKeySchema,
  webhookCreateBodySchema,
  webhookDeliveriesQuerySchema,
  webhookPatchBodySchema,
  webhookSubscriptionSchema,
};
