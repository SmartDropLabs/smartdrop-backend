'use strict';

const mockStore = new Map();
const mockSets = new Map();

const mockRedis = {
  smembers: jest.fn(async (key) => [...(mockSets.get(key) || [])]),
  sadd: jest.fn(async (key, val) => {
    if (!mockSets.has(key)) mockSets.set(key, new Set());
    mockSets.get(key).add(val);
  }),
  srem: jest.fn(async (key, val) => {
    mockSets.get(key)?.delete(val);
  }),
};

const mockSendSignedRequest = jest.fn();

jest.mock('../src/services/cache', () => ({
  getClient: () => mockRedis,
  get: jest.fn(async (key) => {
    const value = mockStore.get(key);
    return value !== undefined ? JSON.parse(JSON.stringify(value)) : null;
  }),
  set: jest.fn(async (key, value) => {
    mockStore.set(key, JSON.parse(JSON.stringify(value)));
  }),
  del: jest.fn(async (key) => {
    mockStore.delete(key);
  }),
}));

jest.mock('../src/services/webhook', () => ({
  sendSignedRequest: mockSendSignedRequest,
}));

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const webhooks = require('../src/services/webhooks');

beforeEach(() => {
  mockStore.clear();
  mockSets.clear();
  mockSendSignedRequest.mockReset();
  mockSendSignedRequest.mockResolvedValue({ ok: true, status: 204, duration_ms: 1 });
  jest.clearAllMocks();
});

function endpoint(overrides = {}) {
  return {
    id: 'wh_test',
    url: 'https://example.com/hook',
    events: ['airdrop.completed'],
    secret: 'whsec_testsecret',
    active: true,
    ...overrides,
  };
}

describe('webhook endpoint service', () => {
  test('creates, lists, and removes endpoints without exposing raw secrets', async () => {
    const created = await webhooks.createEndpoint({
      url: 'https://example.com/hook',
      events: ['airdrop.completed'],
      secret: 'whsec_testsecret',
    });

    expect(created.id).toMatch(/^wh_/);
    expect(created.secret).toBeUndefined();
    expect(created.secret_preview).toBe('whse...cret');

    await expect(webhooks.listEndpoints()).resolves.toEqual([
      expect.objectContaining({ id: created.id, secret_preview: 'whse...cret' }),
    ]);

    await expect(webhooks.removeEndpoint(created.id)).resolves.toMatchObject({ id: created.id });
    await expect(webhooks.listEndpoints()).resolves.toEqual([]);
  });

  test('records a successful delivery after one retry', async () => {
    const transport = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, duration_ms: 12 })
      .mockResolvedValueOnce({ ok: true, status: 204, duration_ms: 8 });
    const wait = jest.fn(async () => {});

    const delivery = await webhooks.processDelivery(
      endpoint(),
      'airdrop.completed',
      { event: 'airdrop.completed' },
      { transport, sleep: wait }
    );

    expect(delivery.status).toBe('delivered');
    expect(delivery.attempt_count).toBe(2);
    expect(delivery.attempts[0]).toMatchObject({ response_code: 500, status: 'failed' });
    expect(delivery.attempts[1]).toMatchObject({ response_code: 204, status: 'delivered' });
    expect(wait).toHaveBeenCalledTimes(1);
  });

  test('moves delivery to dead letter after max attempts', async () => {
    const transport = jest.fn(async () => ({ ok: false, status: 503, duration_ms: 5 }));
    const wait = jest.fn(async () => {});

    const delivery = await webhooks.processDelivery(
      endpoint(),
      'airdrop.failed',
      { event: 'airdrop.failed' },
      { transport, sleep: wait, maxAttempts: 3 }
    );

    expect(delivery.status).toBe('dead_letter');
    expect(delivery.attempt_count).toBe(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect([...mockSets.get('webhooks:dead_letters')]).toContain(delivery.id);
  });

  test('deliverEvent queues subscribed endpoints only', async () => {
    const created = await webhooks.createEndpoint({
      url: 'https://example.com/hook',
      events: ['recipient.claimed'],
      secret: 'whsec_testsecret',
    });
    await webhooks.createEndpoint({
      url: 'https://example.com/other',
      events: ['airdrop.failed'],
      secret: 'whsec_testsecret',
    });

    const deliveries = await webhooks.deliverEvent('recipient.claimed', { event: 'recipient.claimed' });

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].endpoint_id).toBe(created.id);
  });
});
