'use strict';

const {
  alertCreateBodySchema,
  keyCreateBodySchema,
  webhookCreateBodySchema,
  webhookPatchBodySchema,
} = require('../src/validation/schemas');

// #599, #600, #601 — free-form request fields must be bounded so one request
// cannot write an arbitrarily large row.

describe('API key scopes are bounded (#599)', () => {
  test('accepts a normal scope list', () => {
    const result = keyCreateBodySchema.safeParse({ label: 'worker', scopes: ['alerts', 'webhooks'] });
    expect(result.success).toBe(true);
  });

  test('rejects more than 20 scopes', () => {
    const scopes = Array.from({ length: 21 }, (_, i) => `scope${i}`);
    expect(keyCreateBodySchema.safeParse({ label: 'worker', scopes }).success).toBe(false);
  });

  test('rejects a scope longer than 64 characters', () => {
    const result = keyCreateBodySchema.safeParse({ label: 'worker', scopes: ['a'.repeat(65)] });
    expect(result.success).toBe(false);
  });
});

describe('Alert thresholds and secrets are bounded (#600)', () => {
  const base = {
    asset: 'XLM',
    type: 'above',
    threshold_usd: 0.5,
    webhook_url: 'https://example.com/hook',
    webhook_secret: 'secret123',
  };

  test('rejects a threshold above the ceiling', () => {
    const result = alertCreateBodySchema.safeParse({ ...base, threshold_usd: 1e13 });
    expect(result.success).toBe(false);
    expect(result.error.issues.some((i) => i.path[0] === 'threshold_usd')).toBe(true);
  });

  test('rejects a webhook secret longer than 256 characters', () => {
    const result = alertCreateBodySchema.safeParse({ ...base, webhook_secret: 's'.repeat(257) });
    expect(result.success).toBe(false);
    expect(result.error.issues.some((i) => i.path[0] === 'webhook_secret')).toBe(true);
  });

  test('accepts an in-range threshold and secret length', () => {
    const result = alertCreateBodySchema.safeParse({ ...base, webhook_secret: 's'.repeat(256) });
    expect(result.error?.issues?.some((i) => ['threshold_usd', 'webhook_secret'].includes(i.path[0]))).not.toBe(true);
  });
});

describe('Webhook description and secret are bounded (#601)', () => {
  test.each([
    ['create', webhookCreateBodySchema],
    ['patch', webhookPatchBodySchema],
  ])('%s rejects an oversized description and secret', (_name, schema) => {
    const longDescription = schema.safeParse({ description: 'd'.repeat(501) });
    expect(longDescription.success).toBe(false);
    expect(longDescription.error.issues.some((i) => i.path[0] === 'description')).toBe(true);

    const longSecret = schema.safeParse({ secret: 's'.repeat(257) });
    expect(longSecret.success).toBe(false);
    expect(longSecret.error.issues.some((i) => i.path[0] === 'secret')).toBe(true);
  });

  test('trims the description', () => {
    const result = webhookPatchBodySchema.safeParse({ description: '  nightly sync  ' });
    expect(result.success).toBe(true);
    expect(result.data.description).toBe('nightly sync');
  });
});
