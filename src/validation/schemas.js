'use strict';

const { z } = require('zod');
const webhookEvents = require('../services/webhookEvents');

const stellarPublicKeySchema = z
  .string()
  .regex(/^G[A-Z0-9]{55}$/, 'Must be a valid Stellar public key');

const assetCodeSchema = z
  .string()
  .trim()
  .min(1, 'Asset code is required')
  .max(12, 'Asset code must be 12 characters or fewer')
  .regex(/^[A-Za-z0-9]+$/, 'Asset code must be alphanumeric')
  .transform((value) => value.toUpperCase());

const optionalIssuerSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  stellarPublicKeySchema.optional()
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
    .regex(/^[A-Za-z0-9_-]+$/, 'ID can contain only letters, numbers, underscores, and hyphens'),
});

const httpUrlSchema = z
  .string()
  .trim()
  .refine((value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol);
    } catch {
      return false;
    }
  }, {
    message: 'Must be an http(s) URL',
  });

const priceParamsSchema = z.object({
  asset_code: assetCodeSchema,
});

const priceQuerySchema = z.object({
  issuer: optionalIssuerSchema,
});

const keyCreateBodySchema = z.object({
  label: z.string().trim().min(1).max(80),
  scopes: z
    .array(z.string().trim().min(1))
    .nonempty()
    .optional(),
});

const alertCreateBodySchema = z.object({
  asset: assetCodeSchema,
  type: z.enum(['above', 'below', 'change_pct']),
  threshold_usd: z.number().positive(),
  webhook_url: httpUrlSchema,
  webhook_secret: z.string().min(8),
  repeat: z.boolean().optional(),
});

const webhookSubscriptionSchema = z
  .array(z.string())
  .nonempty()
  .refine((value) => webhookEvents.isValidSubscription(value), {
    message: `Must contain ${webhookEvents.WILDCARD} or known events`,
  });

const webhookCreateBodySchema = z.object({
  url: httpUrlSchema,
  events: webhookSubscriptionSchema,
  secret: z.string().min(16).optional(),
  description: z.string().optional(),
});

const webhookPatchBodySchema = z.object({
  url: httpUrlSchema.optional(),
  events: webhookSubscriptionSchema.optional(),
  secret: z.string().min(16).optional(),
  active: z.boolean().optional(),
  description: z.string().optional(),
});

const webhookDeliveriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const recipientSchema = z.object({
  address: stellarPublicKeySchema,
  amount: z.number().positive(),
});

const recipientsSchema = z
  .array(recipientSchema)
  .max(10000, 'recipients cannot exceed 10,000')
  .superRefine((recipients, ctx) => {
    const seen = new Set();
    recipients.forEach((recipient, index) => {
      if (seen.has(recipient.address)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'address'],
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
    .gt(currentLedger, `expiry_ledger must be greater than current ledger (${currentLedger})`);
}

function airdropCreateBodySchema(currentLedger) {
  return z
    .object({
      name: z.string().trim().min(1),
      description: z.string().optional(),
      asset: assetCodeSchema,
      asset_issuer: stellarPublicKeySchema,
      total_amount: z.number().positive(),
      expiry_ledger: expiryLedgerSchema(currentLedger),
      recipients: recipientsSchema.optional().default([]),
    })
    .superRefine((body, ctx) => {
      if (body.recipients.length === 0) return;

      const total = body.recipients.reduce((sum, recipient) => sum + recipient.amount, 0);
      if (total !== body.total_amount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['recipients'],
          message: `sum of recipient amounts (${total}) must equal total_amount (${body.total_amount})`,
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
    if (typeof value !== 'string') return value;

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
