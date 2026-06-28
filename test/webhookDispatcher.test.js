'use strict';

const { createCacheMock } = require('./helpers/cacheMock');

const mockHelper = createCacheMock();
const { reset, zsets } = mockHelper;

jest.mock('../src/services/cache', () => mockHelper.cacheMock);
jest.mock('../src/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
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

    const [delivery] = await dispatcher.dispatch({
      event_type: 'pool.assets_locked',
      event_id: 'evt_1',
      data: { pool_id: 'p1' },
    });

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

    const [delivery] = await dispatcher.dispatch({
      event_type: 'pool.assets_locked',
      event_id: 'evt_retry',
    });

    expect(delivery.status).toBe('pending');
    expect(delivery.attempts).toBe(1);
    expect(delivery.next_retry_at).not.toBeNull();
    expect(delivery.last_error).toBe('HTTP 503');
    const queued = zsets.get('webhooks:retries');
    expect(queued.size).toBe(1);
    expect([...queued.keys()][0]).toBe(delivery.id);
  });

  test('4xx (non-429) does NOT retry and marks failed', async () => {
    await createWebhook();
    mockAxiosPost.mockResolvedValueOnce({ status: 400 });

    const [delivery] = await dispatcher.dispatch({
      event_type: 'pool.assets_locked',
      event_id: 'evt_4xx',
    });

    expect(delivery.status).toBe('failed');
    expect(delivery.attempts).toBe(1);
    expect(delivery.next_retry_at).toBeNull();
    const queued = zsets.get('webhooks:retries') || new Map();
    expect(queued.size).toBe(0);
  });

  test('network errors trigger a retry', async () => {
    await createWebhook();
    mockAxiosPost.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const [delivery] = await dispatcher.dispatch({
      event_type: 'pool.assets_locked',
      event_id: 'evt_net',
    });

    expect(delivery.status).toBe('pending');
    expect(delivery.last_error).toBe('ECONNREFUSED');
    expect(delivery.next_retry_at).not.toBeNull();
  });

  test('after maxAttempts failures the delivery is permanently failed', async () => {
    await createWebhook();
    const [delivery] = await dispatcher.dispatch({
      event_type: 'pool.assets_locked',
      event_id: 'evt_max',
    });

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

    const [delivery] = await dispatcher.dispatch({
      event_type: 'pool.assets_locked',
      event_id: 'evt_429',
    });
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

    const [delivery] = await dispatcher.dispatch({
      event_type: 'pool.assets_locked',
      event_id: 'evt_payload',
      data: { important: 'value' },
    });

    const persisted = await deliveryRepo.findById(delivery.id);
    expect(persisted.payload.data.important).toBe('value');

    mockAxiosPost.mockResolvedValueOnce({ status: 200 });
    const retried = await dispatcher.attempt(delivery.id);
    expect(retried.status).toBe('success');
    const body = JSON.parse(mockAxiosPost.mock.calls[1][1]);
    expect(body.data.important).toBe('value');
  });
});
