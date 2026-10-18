"use strict";

const { z } = require("zod");
const config = require("../config");
const { ALLOWED_ALERT_FIELDS, ALLOWED_CONDITIONS } = require("../services/alerts");
const { isValidStellarAddress } = require("../utils/stellar");

const ASSET_CODE_RE = /^[A-Z0-9]{1,12}$/;
const ROUTE_ID_RE = /^[A-Za-z0-9:_-]{1,128}$/;
const INDEXER_ADDRESS_RE = /^[A-Z0-9]{10,80}$/;
const VALID_TIERS = Object.keys(config.rateLimitTiers || { free: {}, standard: {}, pro: {} });

const routeIdParamsSchema = z
  .object({
    id: z.string().trim().min(1, "id is required"),
  })
  .strict();

const indexerAirdropParamsSchema = z
  .object({
    id: z.string().regex(ROUTE_ID_RE, "Invalid airdrop id"),
  })
  .strict();

const indexerRecipientParamsSchema = z
  .object({
    address: z.string().regex(INDEXER_ADDRESS_RE, "Invalid recipient address"),
  })
  .strict();

const paginationQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
  })
  .strict();

const priceParamsSchema = z
  .object({
    asset_code: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .refine((value) => ASSET_CODE_RE.test(value), {
        message: "Asset code must be 1-12 uppercase alphanumeric characters",
      }),
  })
  .strict();

const priceQuerySchema = z
  .object({
    issuer: z.string().trim().min(1, "issuer cannot be empty").optional(),
  })
  .strict();

const alertCreateBodySchema = z
  .object({
    asset_code: z.string().trim().regex(/^[A-Za-z0-9]{1,12}$/, "Invalid asset_code"),
    field: z.enum(ALLOWED_ALERT_FIELDS),
    condition: z.enum(ALLOWED_CONDITIONS),
    threshold: z.number().finite(),
    webhook_url: z.string().trim().url().optional(),
  })
  .strict();

const keyCreateBodySchema = z
  .object({
    label: z.string().trim().min(1).max(255).optional(),
    scopes: z.array(z.string().trim().min(1)).nonempty().optional(),
    tier: z.enum(VALID_TIERS).optional(),
  })
  .strict();

const keyRotateBodySchema = z
  .object({
    tier: z.enum(VALID_TIERS).optional(),
    grace_period_seconds: z.number().int().min(0).optional(),
  })
  .strict();

const recipientInputSchema = z
  .object({
    address: z.string().trim().refine((val) => isValidStellarAddress(val), {
      message: "Invalid Stellar public key",
    }),
    amount: z
      .union([z.number(), z.string()])
      .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0, {
        message: "Amount must be a positive number",
      }),
  })
  .strict();

const airdropCreateBodySchema = z
  .object({
    title: z.string().trim().max(255).optional(),
    asset_code: z.string().trim().regex(/^[A-Za-z0-9]{1,12}$/, "Invalid asset_code").optional(),
    asset_issuer: z
      .string()
      .trim()
      .refine((value) => isValidStellarAddress(value), {
        message: "Invalid Stellar public key for asset_issuer",
      })
      .optional(),
    total_amount: z
      .union([z.number(), z.string()])
      .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0, {
        message: "total_amount must be a positive number",
      }),
    recipients: z
      .array(recipientInputSchema)
      .nonempty()
      .max(config.limits.maxRecipientsPerAirdrop),
    criteria: z.record(z.any()).optional(),
    start_at: z.string().datetime({ offset: true }).optional(),
    end_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const normalizedAsset = (data.asset_code || "XLM").toUpperCase();
    if (normalizedAsset !== "XLM" && !data.asset_issuer) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["asset_issuer"],
        message: "asset_issuer is required for non-XLM assets",
      });
    }
    if (data.start_at && data.end_at && new Date(data.start_at) >= new Date(data.end_at)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end_at"],
        message: "end_at must be after start_at",
      });
    }
  });

module.exports = {
  routeIdParamsSchema,
  indexerAirdropParamsSchema,
  indexerRecipientParamsSchema,
  paginationQuerySchema,
  priceParamsSchema,
  priceQuerySchema,
  alertCreateBodySchema,
  keyCreateBodySchema,
  keyRotateBodySchema,
  airdropCreateBodySchema,
  recipientInputSchema,
};