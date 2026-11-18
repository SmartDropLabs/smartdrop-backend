'use strict';

/**
 * #605 — free-text and secret fields are stored in unbounded TEXT columns,
 * so the request schemas are the only cap on how much one request can store.
 */

jest.mock('../src/config', () => ({
  watchedAssets: [],
  apiKeyRateLimit: { tiers: { free: {}, pro: {} } },
}));

const {
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_SECRET_LENGTH,
  airdropCreateBodySchema,
  airdropUpdateBodySchema,
  alertCreateBodySchema,
  webhookCreateBodySchema,
  webhookPatchBodySchema,
} = require('../src/validation/schemas');

const ISSUER = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

const airdrop = (overrides) => ({
  name: 'Drop',
  asset: 'USDC',
  asset_issuer: ISSUER,
  total_amount: 10,
  expiry_ledger: 200,
  ...overrides,
});

const alert = (overrides) => ({
  asset: 'XLM',
  type: 'above',
  threshold_usd: 1,
  webhook_url: 'https://example.com/hook',
  webhook_secret: 'secret-secret',
  ...overrides,
});

const webhook = (overrides) => ({
  url: 'https://example.com/hook',
  events: ['*'],
  ...overrides,
});

describe('input length bounds (#605)', () => {
  test('airdrop name is capped on create and update', () => {
    const create = airdropCreateBodySchema(100);
    const update = airdropUpdateBodySchema(100);
    const tooLong = 'n'.repeat(MAX_NAME_LENGTH + 1);

    expect(create.safeParse(airdrop({ name: 'n'.repeat(MAX_NAME_LENGTH) })).success).toBe(true);
    expect(create.safeParse(airdrop({ name: tooLong })).success).toBe(false);
    expect(update.safeParse({ name: tooLong }).success).toBe(false);
  });

  test('descriptions are capped on airdrops and webhooks', () => {
    const tooLong = 'd'.repeat(MAX_DESCRIPTION_LENGTH + 1);
    const ok = 'd'.repeat(MAX_DESCRIPTION_LENGTH);

    expect(airdropCreateBodySchema(100).safeParse(airdrop({ description: ok })).success).toBe(true);
    expect(airdropCreateBodySchema(100).safeParse(airdrop({ description: tooLong })).success).toBe(false);
    expect(airdropUpdateBodySchema(100).safeParse({ description: tooLong }).success).toBe(false);
    expect(webhookCreateBodySchema.safeParse(webhook({ description: tooLong })).success).toBe(false);
    expect(webhookPatchBodySchema.safeParse({ description: tooLong }).success).toBe(false);
  });

  test('webhook and alert secrets are capped', () => {
    const tooLong = 's'.repeat(MAX_SECRET_LENGTH + 1);

    expect(webhookCreateBodySchema.safeParse(webhook({ secret: tooLong })).success).toBe(false);
    expect(webhookPatchBodySchema.safeParse({ secret: tooLong }).success).toBe(false);
    expect(alertCreateBodySchema.safeParse(alert({ webhook_secret: tooLong })).success).toBe(false);
    expect(
      alertCreateBodySchema.safeParse(alert({ webhook_secret: 's'.repeat(MAX_SECRET_LENGTH) })).success,
    ).toBe(true);
  });
});
