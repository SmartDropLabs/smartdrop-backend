'use strict';

// Keep the test rate-limit budget small so we can prove that testing many
// *different* webhooks from one IP does NOT bypass the per-IP limit. Must be
// set before config is required below.
process.env.WEBHOOK_TEST_RATELIMIT_MAX = '5';
process.env.WEBHOOK_TEST_RATELIMIT_WINDOW = '60';

const express = require('express');
const request = require('supertest');
const { createCacheMock } = require('./helpers/cacheMock');

const mockHelper = createCacheMock();
const { reset } = mockHelper;

jest.mock('../src/services/cache', () => mockHelper.cacheMock);

const mockAxiosPost = jest.fn();
jest.mock('axios', () => ({ post: (...args) => mockAxiosPost(...args) }));

const webhooksRouter = require('../src/routes/webhooks');
const webhookRepo = require('../src/repositories/webhookRepository');
const logger = require('../src/logger');
const { errorHandler, notFoundHandler } = require('../src/middleware/errorHandler');

// A real, public IP literal (example.com's historical address) — used so the
// SSRF guard's resolution path is exercised without any live DNS lookup.
const PUBLIC_TARGET = 'http://93.184.216.34/';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', webhooksRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

async function seedWebhook(url) {
  return webhookRepo.create({
    url,
    events: ['*'],
    secret: 'whsec_aaaaaaaaaaaaaaaa',
  });
}

beforeEach(() => {
  reset();
  mockAxiosPost.mockReset();
});

describe('webhook SSRF guard (#96)', () => {
  const app = buildApp();

  test.each([
    ['RFC1918', 'http://10.0.0.5/'],
    ['loopback', 'http://127.0.0.1/'],
    ['link-local cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['IPv6 loopback', 'http://[::1]/'],
  ])('refuses testing a webhook targeting a private/internal address (%s)', async (label, url) => {
    const webhook = await seedWebhook(url);

    const res = await request(app).post(`/api/v1/webhooks/${webhook.id}/test`);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('WEBHOOK_TARGET_BLOCKED');
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  test('blocks a private target even when seeded directly, bypassing create-time validation (defense in depth)', async () => {
    // The route-level schema would reject a private URL at POST /webhooks, so
    // seed straight into the repository to simulate a bypass/refactor gap and
    // prove the delivery-time check is what actually stops it.
    const webhook = await seedWebhook('http://192.168.1.1/');
    const res = await request(app).post(`/api/v1/webhooks/${webhook.id}/test`);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('WEBHOOK_TARGET_BLOCKED');
  });

  test('allows testing a public target and reports success', async () => {
    const webhook = await seedWebhook(PUBLIC_TARGET);
    mockAxiosPost.mockResolvedValueOnce({ status: 200 });

    const res = await request(app).post(`/api/v1/webhooks/${webhook.id}/test`);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('success');
  });
});

describe('webhook test endpoint error detail reduction (#96)', () => {
  const app = buildApp();
  let warnSpy;

  beforeEach(() => {
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('does not leak raw network error codes; returns a generic category but logs the raw detail', async () => {
    const webhook = await seedWebhook(PUBLIC_TARGET);
    mockAxiosPost.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = await request(app).post(`/api/v1/webhooks/${webhook.id}/test`);

    expect(res.status).toBe(202);
    expect(res.body.last_error).toBe('unreachable');
    expect(String(res.body.last_error)).not.toContain('ECONNREFUSED');

    // Raw low-level detail is preserved server-side for operators.
    const loggedRaw = warnSpy.mock.calls.some(([msg, meta]) =>
      String(msg).toLowerCase().includes('failed') &&
      meta && String(meta.error).includes('ECONNREFUSED'));
    expect(loggedRaw).toBe(true);
  });

  test('does not leak raw HTTP error strings; returns a generic category', async () => {
    const webhook = await seedWebhook(PUBLIC_TARGET);
    mockAxiosPost.mockResolvedValueOnce({ status: 500 });

    const res = await request(app).post(`/api/v1/webhooks/${webhook.id}/test`);

    expect(res.status).toBe(202);
    expect(res.body.last_error).toBe('error_response');
    expect(String(res.body.last_error)).not.toMatch(/^HTTP /);
  });
});

describe('webhook test rate-limit aggregates per IP (#96)', () => {
  const app = buildApp();

  test('testing N different webhooks from one IP shares a single budget', async () => {
    const webhooks = [];
    for (let i = 0; i < 10; i += 1) {
      // Distinct public targets so the SSRF guard passes for each.
      webhooks.push(await seedWebhook(`http://93.184.216.${34 + i % 3}/`));
    }
    mockAxiosPost.mockResolvedValue({ status: 200 });

    const results = [];
    for (const wh of webhooks) {
      results.push(await request(app).post(`/api/v1/webhooks/${wh.id}/test`));
    }

    const succeeded = results.filter((r) => r.status === 202).length;
    const limited = results.filter((r) => r.status === 429).length;

    // Budget is 5 per IP per window — testing 10 *different* webhooks must not
    // each get their own allowance; only 5 succeed, the rest are limited.
    expect(succeeded).toBe(5);
    expect(limited).toBe(5);
    results.filter((r) => r.status === 429).forEach((r) => {
      expect(r.body.error.code).toBe('RATE_LIMITED');
    });
  });
});
