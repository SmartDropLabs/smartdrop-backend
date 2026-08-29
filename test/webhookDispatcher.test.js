'use strict';

const { createCacheMock } = require('./helpers/cacheMock');

const mockHelper = createCacheMock();
const { reset, zsets } = mockHelper;

jest.mock('../src/services/cache', () => mockHelper.cacheMock);
jest.mock('../src/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
// Passthrough SSRF guard so dispatcher tests don't perform live DNS resolution
// and so the original (un-pinned) URL reaches the axios mock as before.
jest.mock('../src/services/ssrfGuard', () => ({
  assertPublicTarget: jest.fn(async (url) => ({ targetUrl: url, host: null })),
  assertPublicUrlSync: jest.fn((url) => url),
  isPrivateIp: jest.fn(() => false),
}));

const mockAxiosPost = jest.fn();
jest.mock('axios', () => ({ post: (...args) => mockAxiosPost(...args) }));

const dispatcher = require('../src/services/webhookDispatcher');
const webhookRepo = require('../src/repositories/webhookRepository');
const deliveryRepo = require('../src/repositories/deliveryRepository');
const signature = require('../src/services/webhookSignature');

beforeEach(() => {
  reset();
  mockAxiosPost.mockReset();
});

async function createWebhook(overrides = {}) {
  return webhookRepo.create({
    url: 'https://example.com/hook',
    events: ['pool.assets_locked'],
    secret: 'whsec_aaaaaaaaaaaaaaaa',
    ...overrides,
  });
}

describe('dispatcher delivery success', () => {
  test('successful 200 marks delivery as success with attempts=1', async () => {
    const w = await createWebhook();
    mockAxiosPost.mockResolvedValueOnce({ status: 200 });

    const results = await dispatcher.dispatch({
      event_type: 'pool.assets_locked',
      event_id: 'evt_1',
      data: { pool_id: 'p1' },
    });

    const [{ delivery }] = results;
    expect(delivery.status).toBe('success');
    expect(delivery.attempts).toBe(1);
    expect(delivery.response_status).toBe(200);
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);

    const [url, body, opts] = mockAxiosPost.mock.calls[0];
    expect(url).toBe(w.url);
    expect(typeof body).toBe('string');
    const parsed = JSON.parse(body);
    expect(parsed.event).toBe('pool.assets_locked');
    expect(parsed.event_id).toBe('evt_1');
    expect(parsed.data).toEqual({ pool_id: 'p1' });
    expect(opts.headers['X-SmartDrop-Signature']).toBe(signature.sign(w.secret, body));
    expect(opts.headers['X-SmartDrop-Event']).toBe('pool.assets_locked');
  });
});

describe('dispatcher event-type filtering', () => {
  test('only webhooks subscribed to the event receive a delivery', async () => {
    await createWebhook({ url: 'https://a.com', events: ['pool.assets_locked'] });
    await createWebhook({ url: 'https://b.com', events: ['pool.closed'] });
    await createWebhook({ url: 'https://c.com', events: ['*'] });
    mockAxiosPost.mockResolvedValue({ status: 200 });

    const results = await dispatcher.dispatch({
      event_type: 'pool.assets_locked',
      event_id: 'evt_42',
    });

    expect(results).toHaveLength(2);
    const urls = mockAxiosPost.mock.calls.map((c) => c[0]).sort();
    expect(urls).toEqual(['https://a.com', 'https://c.com']);
  });

  test('webhook filters narrow deliveries to matching pools', async () => {
    await createWebhook({ url: 'https://a.com', events: ['pool.assets_locked'], filters: { pool_id: 'pool_1' } });
    await createWebhook({ url: 'https://b.com', events: ['pool.assets_locked'], filters: { pool_id: 'pool_2' } });
    mockAxiosPost.mockResolvedValue({ status: 200 });

    const results = await dispatcher.dispatch({
      event_type: 'pool.assets_locked',
      event_id: 'evt_filtered',
      data: { pool_id: 'pool_1', asset: 'USDC' },
    });

    expect(results).toHaveLength(1);
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    expect(mockAxiosPost.mock.calls[0][0]).toBe('https://a.com');
  });

  test('payload includes monotonically increasing sequence number', async () => {
    await createWebhook({ url: 'https://a.com', events: ['pool.assets_locked'] });
    mockAxiosPost.mockResolvedValue({ status: 200 });

    await dispatcher.dispatch({
      event_type: 'pool.assets_locked',
      event_id: 'evt_seq1',
      data: { pool_id: 'p1' },
    });
    await dispatcher.dispatch({
      event_type: 'pool.assets_locked',
      event_id: 'evt_seq2',
      data: { pool_id: 'p1' },
    });

    const bodies = mockAxiosPost.mock.calls.map((c) => JSON.parse(c[1]));
    expect(bodies[0].sequence).toBe(1);
    expect(bodies[1].sequence).toBe(2);
  });

  test('returns structured result with webhook_id and delivery', async () => {
    await createWebhook({ url: 'https://a.com', events: ['pool.assets_locked'] });
    mockAxiosPost.mockResolvedValue({ status: 200 });

    const results = await dispatcher.dispatch({
      event_type: 'pool.assets_locked',
      event_id: 'evt_struct',
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toHaveProperty('webhook_id');
    expect(results[0]).toHaveProperty('delivery');
    expect(results[0].error).toBeNull();
  });

  test('captures error per-target when deliverToWebhook throws', async () => {
    const good = await createWebhook({ url: 'https://good.com', events: ['pool.assets_locked'] });
    const bad = await createWebhook({ url: 'https://bad.com', events: ['pool.assets_locked'] });
    // good succeeds, bad fails
    mockAxiosPost.mockImplementation(async (url) => {
      if (url === 'https://bad.com') throw new Error('ECONNREFUSED');
      return { status: 200 };
    });

    const results = await dispatcher.dispatch({
      event_type: 'pool.assets_locked',
      event_id: 'evt_partial',
    });

    expect(results).toHaveLength(2);
    const goodResult = results.find((r) => r.webhook_id === good.id);
    const badResult = results.find((r) => r.webhook_id === bad.id);
    expect(goodResult.delivery.status).toBe('success');
    // bad.com's attempt() catches internally and returns a delivery with status 'pending' (retryable)
    expect(badResult.delivery.status).toBe('pending');
    expect(badResult.delivery.last_error).toBe('ECONNREFUSED');
  });

  test('inactive webhooks are skipped', async () => {
    const w = await createWebhook();
    await webhookRepo.update(w.id, { active: false });
    mockAxiosPost.mockResolvedValue({ status: 200 });

    const results = await dispatcher.dispatch({
      event_type: 'pool.assets_locked',
      event_id: 'evt_skip',
    });
    expect(results).toHaveLength(0);
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  test('unknown event types do not dispatch', async () => {
    await createWebhook();
    const results = await dispatcher.dispatch({
      event_type: 'foo.bar',
      event_id: 'evt_x',
    });
    expect(results).toEqual([]);
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });
});

describe('dispatcher retry semantics', () => {
  test('5xx schedules a retry and keeps status pending', async () => {
    await createWebhook();
    mockAxiosPost.mockResolvedValueOnce({ status: 503 });

    const results = await dispatcher.dispatch({
      event_type: 'pool.assets_locked',
      event_id: 'evt_retry',
    });

    const [{ delivery }] = results;
    expect(delivery.status).toBe('pending');
    expect(delivery.attempts).toBe(1);
    expect(delivery.next_retry_at).not.toBeNull();
    expect(delivery.last_error).toBe('HTTP 503');
    const queued = zsets.get('webhooks:retries');
    expect(queued.size).toBe(1);
    expect([...queued.keys()][0]).toBe(delivery.id);
  });

  test('retry scheduling uses the backoff delay from the current attempt count', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      await createWebhook();
      mockAxiosPost.mockResolvedValueOnce({ status: 503 });

      const results = await dispatcher.dispatch({
        event_type: 'pool.assets_locked',
        event_id: 'evt_backoff_schedule',
      });

      const [{ delivery }] = results;
      const expectedRetryAt = 1_700_000_000_000 + 15_000;
      expect(delivery.next_retry_at).toBe(new Date(expectedRetryAt).toISOString());
      expect(zsets.get('webhooks:retries').get(delivery.id)).toBe(expectedRetryAt);
    } finally {
      Date.now.mockRestore();
      randomSpy.mockRestore();
    }
  });

  test('4xx (non-429) does NOT retry and marks failed', async () => {
    await createWebhook();
    mockAxiosPost.mockResolvedValueOnce({ status: 400 });

    const results = await dispatcher.dispatch({
      event_type: 'pool.assets_locked',
      event_id: 'evt_4xx',
    });

    const [{ delivery }] = results;
    expect(delivery.status).toBe('failed');
    expect(delivery.attempts).toBe(1);
    expect(delivery.next_retry_at).toBeNull();
    const queued = zsets.get('webhooks:retries') || new Map();
    expect(queued.size).toBe(0);
  });

  test('network errors trigger a retry', async () => {
    await createWebhook();
    mockAxiosPost.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const results = await dispatcher.dispatch({
      event_type: 'pool.assets_locked',
      event_id: 'evt_net',
    });

    const [{ delivery }] = results;
    expect(delivery.status).toBe('pending');
    expect(delivery.last_error).toBe('ECONNREFUSED');
    expect(delivery.next_retry_at).not.toBeNull();
  });

  test('after maxAttempts failures the delivery is permanently failed', async () => {
    await createWebhook();
    const results = await dispatcher.dispatch({
      event_type: 'pool.assets_locked',
      event_id: 'evt_max',
    });

    const [{ delivery }] = results;
    mockAxiosPost.mockResolvedValue({ status: 500 });
    const second = await dispatcher.attempt(delivery.id);
    const third = await dispatcher.attempt(delivery.id);

    expect(third.status).toBe('failed');
    expect(third.attempts).toBe(3);
    expect(third.next_retry_at).toBeNull();
    expect(second.status).toBe('pending');
  });

  test('429 is treated as retryable', async () => {
    await createWebhook();
    mockAxiosPost.mockResolvedValueOnce({ status: 429 });

    const results = await dispatcher.dispatch({
      event_type: 'pool.assets_locked',
      event_id: 'evt_429',
    });
    const [{ delivery }] = results;
    expect(delivery.status).toBe('pending');
    expect(delivery.next_retry_at).not.toBeNull();
  });
});

describe('exponential backoff', () => {
  test('delay grows by retryFactor each attempt', () => {
    const d1 = dispatcher.backoffMs(1);
    const d2 = dispatcher.backoffMs(2);
    const d3 = dispatcher.backoffMs(3);
    expect(d2).toBeGreaterThan(d1);
    expect(d3).toBeGreaterThan(d2);
  });
});

describe('backoff jitter (#128)', () => {
  test('repeated calls with the same attemptsCompleted produce a distribution, not an identical value', () => {
    // Simulates 100 deliveries all failing on attempt 1 "at once" — before
    // jitter, every one of these computed exactly the same delay.
    const delays = new Set();
    for (let i = 0; i < 100; i++) {
      delays.add(dispatcher.backoffMs(1));
    }
    expect(delays.size).toBeGreaterThan(1);
  });

  test('an injected random source of 0 produces exactly the lower bound (deterministic / 2)', () => {
    // config defaults: base=30000, factor=2 -> attempt 1 deterministic=30000
    const delay = dispatcher.backoffMs(1, { random: () => 0 });
    expect(delay).toBe(15000);
  });

  test('an injected random source just under 1 stays just under the deterministic upper bound', () => {
    const delay = dispatcher.backoffMs(1, { random: () => 0.999999 });
    expect(delay).toBeLessThan(30000);
    expect(delay).toBeGreaterThan(29999);
  });

  test('delay is never zero or negative, even at the minimum jitter, across several attempt counts', () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const delay = dispatcher.backoffMs(attempt, { random: () => 0 });
      expect(delay).toBeGreaterThan(0);
    }
  });

  test('delay never reaches or exceeds the undjittered deterministic value, across several attempt counts', () => {
    const base = 30000;
    const factor = 2;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const deterministic = base * factor ** (attempt - 1);
      const delay = dispatcher.backoffMs(attempt, { random: () => 0.999999 });
      expect(delay).toBeLessThan(deterministic);
    }
  });

  test('delay still strictly grows across attempts even in the worst-case jitter ordering', () => {
    // Worst case for monotonicity: attempt N rolls the minimum possible
    // jitter (random=0) while attempt N-1 rolls the maximum (random~1).
    // Even then, attempt N's delay must exceed attempt N-1's, because the
    // default 2x factor means each attempt's [half, full) range never
    // overlaps the previous attempt's range.
    const attempt1Max = dispatcher.backoffMs(1, { random: () => 0.999999 });
    const attempt2Min = dispatcher.backoffMs(2, { random: () => 0 });
    expect(attempt2Min).toBeGreaterThan(attempt1Max);

    const attempt2Max = dispatcher.backoffMs(2, { random: () => 0.999999 });
    const attempt3Min = dispatcher.backoffMs(3, { random: () => 0 });
    expect(attempt3Min).toBeGreaterThan(attempt2Max);
  });

  test('defaults to the real Math.random when no random source is injected', () => {
    const spy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const delay = dispatcher.backoffMs(1);
      expect(spy).toHaveBeenCalled();
      expect(delay).toBe(15000 + 0.5 * 15000);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('thundering-herd prevention across a real dispatch tick (#128)', () => {
  test('many deliveries failing at the same attempt within one tick get spread next_retry_at values', async () => {
    // 20 different subscribers, all failing on attempt 1 at the same
    // wall-clock moment (one dispatch() call, one Promise.all batch) —
    // exactly the scenario the issue describes: a correlated outage
    // affecting many in-flight deliveries at once.
    const webhookCount = 20;
    for (let i = 0; i < webhookCount; i++) {
      await createWebhook({ url: `https://sub-${i}.example.com` });
    }
    mockAxiosPost.mockResolvedValue({ status: 503 });

    const results = await dispatcher.dispatch({
      event_type: 'pool.assets_locked',
      event_id: 'evt_herd',
    });

    expect(results).toHaveLength(webhookCount);
    results.forEach((r) => expect(r.delivery.status).toBe('pending'));

    const nextRetryAtValues = new Set(results.map((r) => r.delivery.next_retry_at));
    expect(nextRetryAtValues.size).toBeGreaterThan(1);
  });
});

describe('shouldRetry decision table', () => {
  test('retries on network error', () => expect(dispatcher.shouldRetry(null, true)).toBe(true));
  test('retries on 500', () => expect(dispatcher.shouldRetry(500, false)).toBe(true));
  test('retries on 503', () => expect(dispatcher.shouldRetry(503, false)).toBe(true));
  test('retries on 408', () => expect(dispatcher.shouldRetry(408, false)).toBe(true));
  test('retries on 429', () => expect(dispatcher.shouldRetry(429, false)).toBe(true));
  test('does not retry on 400', () => expect(dispatcher.shouldRetry(400, false)).toBe(false));
  test('does not retry on 404', () => expect(dispatcher.shouldRetry(404, false)).toBe(false));
  test('does not retry on 200', () => expect(dispatcher.shouldRetry(200, false)).toBe(false));
});

describe('sendTest', () => {
  test('sends a test event to a specific webhook', async () => {
    const w = await createWebhook();
    mockAxiosPost.mockResolvedValueOnce({ status: 200 });
    const delivery = await dispatcher.sendTest(w.id);
    expect(delivery.status).toBe('success');
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockAxiosPost.mock.calls[0][1]);
    expect(body.data.test).toBe(true);
  });

  test('returns null for unknown webhook', async () => {
    const result = await dispatcher.sendTest('wh_unknown');
    expect(result).toBeNull();
  });
});

describe('delivery payload persistence', () => {
  test('payload is persisted so retries do not lose event data', async () => {
    await createWebhook();
    mockAxiosPost.mockResolvedValueOnce({ status: 500 });

    const results = await dispatcher.dispatch({
      event_type: 'pool.assets_locked',
      event_id: 'evt_payload',
      data: { important: 'value' },
    });

    const [{ delivery }] = results;
    const persisted = await deliveryRepo.findById(delivery.id);
    expect(persisted.payload.data.important).toBe('value');

    mockAxiosPost.mockResolvedValueOnce({ status: 200 });
    const retried = await dispatcher.attempt(delivery.id);
    expect(retried.status).toBe('success');
    const body = JSON.parse(mockAxiosPost.mock.calls[1][1]);
    expect(body.data.important).toBe('value');
  });
});

describe('delivery trace ids', () => {
  test('persist a delivery trace id for background dispatches', async () => {
    await createWebhook();
    mockAxiosPost.mockResolvedValueOnce({ status: 500 });

    const results = await dispatcher.dispatch({
      event_type: 'pool.assets_locked',
      event_id: 'evt_trace',
    });

    const [{ delivery }] = results;
    expect(delivery.trace_id).toMatch(/^trace_/);
  });
});

describe('request id propagation into webhook deliveries (issue #250)', () => {
  const { requestContext } = require('../src/middleware/requestId');

  test('stamps the originating request id onto the delivery record', async () => {
    await createWebhook();
    mockAxiosPost.mockResolvedValueOnce({ status: 200 });

    const [{ delivery }] = await requestContext.run({ requestId: 'req_from_api' }, () =>
      dispatcher.dispatch({
        event_type: 'pool.assets_locked',
        event_id: 'evt_req_id',
        data: { pool_id: 'p1' },
      }));

    expect(delivery.request_id).toBe('req_from_api');
    await expect(deliveryRepo.findById(delivery.id))
      .resolves.toEqual(expect.objectContaining({ request_id: 'req_from_api' }));
  });

  test('forwards the request id to the receiver as an X-Request-Id header', async () => {
    await createWebhook();
    mockAxiosPost.mockResolvedValueOnce({ status: 200 });

    await requestContext.run({ requestId: 'req_header' }, () =>
      dispatcher.dispatch({
        event_type: 'pool.assets_locked',
        event_id: 'evt_req_header',
        data: { pool_id: 'p1' },
      }));

    const [, , opts] = mockAxiosPost.mock.calls[0];
    expect(opts.headers['X-Request-Id']).toBe('req_header');
  });

  test('a retry hours later still carries the request id of the original call', async () => {
    await createWebhook();
    mockAxiosPost.mockResolvedValueOnce({ status: 500 });

    const [{ delivery }] = await requestContext.run({ requestId: 'req_retried' }, () =>
      dispatcher.dispatch({
        event_type: 'pool.assets_locked',
        event_id: 'evt_retry_req_id',
        data: { pool_id: 'p1' },
      }));
    expect(delivery.status).toBe('pending');

    // The retry runs from the background worker, outside any request context.
    mockAxiosPost.mockResolvedValueOnce({ status: 200 });
    const retried = await dispatcher.attempt(delivery.id);

    expect(retried.status).toBe('success');
    expect(retried.request_id).toBe('req_retried');
    const [, , opts] = mockAxiosPost.mock.calls[1];
    expect(opts.headers['X-Request-Id']).toBe('req_retried');
  });

  test('omits the header for deliveries with no originating request', async () => {
    await createWebhook();
    mockAxiosPost.mockResolvedValueOnce({ status: 200 });

    const [{ delivery }] = await dispatcher.dispatch({
      event_type: 'pool.assets_locked',
      event_id: 'evt_no_req',
      data: { pool_id: 'p1' },
    });

    expect(delivery.request_id).toBeNull();
    const [, , opts] = mockAxiosPost.mock.calls[0];
    expect(opts.headers['X-Request-Id']).toBeUndefined();
  });
});
