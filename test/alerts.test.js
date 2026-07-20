'use strict';

const mockStore = new Map();
const mockSets = new Map();
const mockZSets = new Map();

function getSortedZSetMembers(key) {
  const z = mockZSets.get(key);
  if (!z) return [];
  return [...z.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([member]) => member);
}

const mockRedis = {
  smembers: jest.fn(async (key) => [...(mockSets.get(key) || [])]),
  sadd: jest.fn(async (key, val) => { if (!mockSets.has(key)) mockSets.set(key, new Set()); mockSets.get(key).add(val); }),
  srem: jest.fn(async (key, val) => { mockSets.get(key)?.delete(val); }),
  zadd: jest.fn(async (key, score, member) => {
    if (!mockZSets.has(key)) mockZSets.set(key, new Map());
    mockZSets.get(key).set(member, Number(score));
  }),
  zrem: jest.fn(async (key, ...members) => {
    const z = mockZSets.get(key);
    if (!z) return;
    for (const m of members) z.delete(m);
  }),
  zrevrange: jest.fn(async (key, start, stop) => {
    const sorted = getSortedZSetMembers(key);
    const end = stop === -1 ? sorted.length : stop + 1;
    return sorted.slice(start, end);
  }),
  zcard: jest.fn(async (key) => (mockZSets.get(key)?.size || 0)),
};

jest.mock('../src/services/cache', () => ({
  getClient: () => mockRedis,
  get: jest.fn(async (key) => {
    const v = mockStore.get(key);
    return v !== undefined ? JSON.parse(JSON.stringify(v)) : null;
  }),
  set: jest.fn(async (key, value) => { mockStore.set(key, JSON.parse(JSON.stringify(value))); }),
  del: jest.fn(async (key) => { mockStore.delete(key); }),
}));

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const mockWebhookDeliver = jest.fn(async () => {});
jest.mock('../src/services/webhook', () => ({ deliver: mockWebhookDeliver }));

const alertsService = require('../src/services/alerts');
const cache = require('../src/services/cache');

beforeEach(() => {
  mockStore.clear();
  mockSets.clear();
  mockZSets.clear();
  mockWebhookDeliver.mockClear();
  cache.get.mockClear();
  cache.set.mockClear();
  cache.del.mockClear();
  mockRedis.smembers.mockClear();
  mockRedis.sadd.mockClear();
  mockRedis.srem.mockClear();
});

async function makeAlert(overrides = {}) {
  return alertsService.create({
    asset: 'XLM',
    type: 'below',
    threshold_usd: 0.09,
    webhook_url: 'https://example.com/hook',
    webhook_secret: 'whsec_testsecret',
    repeat: false,
    ...overrides,
  });
}

describe('alert creation', () => {
  test('returns alert with generated id and normalised asset', async () => {
    const alert = await makeAlert();
    expect(alert.id).toMatch(/^alrt_/);
    expect(alert.asset).toBe('XLM');
    expect(alert.type).toBe('below');
    expect(alert.repeat).toBe(false);
    expect(alert.last_fired_at).toBeNull();
  });

  test('sets baseline_price from cache for change_pct type', async () => {
    mockStore.set('price:XLM', { price: 0.12 });
    const alert = await makeAlert({ type: 'change_pct', threshold_usd: 10 });
    expect(alert.baseline_price).toBe(0.12);
  });

  test('baseline_price is null when no cached price exists for change_pct', async () => {
    const alert = await makeAlert({ type: 'change_pct', threshold_usd: 10 });
    expect(alert.baseline_price).toBeNull();
  });
});

describe('below alert', () => {
  test('fires when price is below threshold', async () => {
    await makeAlert({ threshold_usd: 0.09 });
    await alertsService.evaluateForAsset('XLM', 0.087);
    expect(mockWebhookDeliver).toHaveBeenCalledTimes(1);
    const payload = mockWebhookDeliver.mock.calls[0][2];
    expect(payload.event).toBe('price.alert');
    expect(payload.type).toBe('below');
    expect(payload.actual_price_usd).toBe(0.087);
  });

  test('does not fire when price is above threshold', async () => {
    await makeAlert({ threshold_usd: 0.09 });
    await alertsService.evaluateForAsset('XLM', 0.10);
    expect(mockWebhookDeliver).not.toHaveBeenCalled();
  });

  test('does not fire when price equals threshold', async () => {
    await makeAlert({ threshold_usd: 0.09 });
    await alertsService.evaluateForAsset('XLM', 0.09);
    expect(mockWebhookDeliver).not.toHaveBeenCalled();
  });
});

describe('above alert', () => {
  test('fires when price is above threshold', async () => {
    await makeAlert({ type: 'above', threshold_usd: 0.15 });
    await alertsService.evaluateForAsset('XLM', 0.16);
    expect(mockWebhookDeliver).toHaveBeenCalledTimes(1);
  });

  test('does not fire when price is below threshold', async () => {
    await makeAlert({ type: 'above', threshold_usd: 0.15 });
    await alertsService.evaluateForAsset('XLM', 0.14);
    expect(mockWebhookDeliver).not.toHaveBeenCalled();
  });
});

describe('change_pct alert', () => {
  test('fires when price changes by >= threshold percent', async () => {
    mockStore.set('price:XLM', { price: 0.10 });
    await makeAlert({ type: 'change_pct', threshold_usd: 10 });
    await alertsService.evaluateForAsset('XLM', 0.111);
    expect(mockWebhookDeliver).toHaveBeenCalledTimes(1);
  });

  test('does not fire when change is below threshold percent', async () => {
    mockStore.set('price:XLM', { price: 0.10 });
    await makeAlert({ type: 'change_pct', threshold_usd: 10 });
    await alertsService.evaluateForAsset('XLM', 0.105);
    expect(mockWebhookDeliver).not.toHaveBeenCalled();
  });

  test('does not fire when baseline_price is null', async () => {
    await makeAlert({ type: 'change_pct', threshold_usd: 5 });
    await alertsService.evaluateForAsset('XLM', 0.20);
    expect(mockWebhookDeliver).not.toHaveBeenCalled();
  });
});

describe('repeat: false', () => {
  test('alert is deleted after firing', async () => {
    await makeAlert({ repeat: false, threshold_usd: 0.09 });
    await alertsService.evaluateForAsset('XLM', 0.08);
    expect(mockWebhookDeliver).toHaveBeenCalledTimes(1);

    const remaining = await alertsService.list();
    expect(remaining).toHaveLength(0);
  });
});

describe('repeat: true with cooldown', () => {
  test('fires on first trigger', async () => {
    await makeAlert({ repeat: true, threshold_usd: 0.09 });
    await alertsService.evaluateForAsset('XLM', 0.08);
    expect(mockWebhookDeliver).toHaveBeenCalledTimes(1);
  });

  test('does not re-fire within 5-minute cooldown', async () => {
    await makeAlert({ repeat: true, threshold_usd: 0.09 });

    await alertsService.evaluateForAsset('XLM', 0.08);
    expect(mockWebhookDeliver).toHaveBeenCalledTimes(1);

    await alertsService.evaluateForAsset('XLM', 0.07);
    expect(mockWebhookDeliver).toHaveBeenCalledTimes(1);
  });

  test('alert remains in list after firing', async () => {
    await makeAlert({ repeat: true, threshold_usd: 0.09 });
    await alertsService.evaluateForAsset('XLM', 0.08);
    const remaining = await alertsService.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].last_fired_at).not.toBeNull();
  });

  test('fires again after cooldown expires', async () => {
    await makeAlert({ repeat: true, threshold_usd: 0.09 });

    await alertsService.evaluateForAsset('XLM', 0.08);
    expect(mockWebhookDeliver).toHaveBeenCalledTimes(1);

    // Backdate last_fired_at by 6 minutes
    const [alert] = await alertsService.list();
    const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    mockStore.set(`alert:${alert.id}`, { ...alert, last_fired_at: sixMinutesAgo });

    await alertsService.evaluateForAsset('XLM', 0.07);
    expect(mockWebhookDeliver).toHaveBeenCalledTimes(2);
  });
});

describe('CRUD via service', () => {
  test('list returns empty array initially', async () => {
    const alerts = await alertsService.list();
    expect(alerts).toHaveLength(0);
  });

  test('list returns all created alerts', async () => {
    await makeAlert();
    await makeAlert({ type: 'above', threshold_usd: 0.15 });
    const alerts = await alertsService.list();
    expect(alerts).toHaveLength(2);
  });

  test('remove deletes alert and returns it', async () => {
    const alert = await makeAlert();
    const deleted = await alertsService.remove(alert.id);
    expect(deleted.id).toBe(alert.id);
    expect(await alertsService.list()).toHaveLength(0);
  });

  test('remove returns null for unknown id', async () => {
    expect(await alertsService.remove('alrt_nonexistent')).toBeNull();
  });
});

describe('evaluateAll', () => {
  test('evaluates alerts using current price from cache', async () => {
    mockStore.set('price:XLM', { price: 0.08 });
    await makeAlert({ threshold_usd: 0.09 });
    await alertsService.evaluateAll();
    expect(mockWebhookDeliver).toHaveBeenCalledTimes(1);
  });

  test('skips assets with no cached price', async () => {
    await makeAlert({ threshold_usd: 0.09 });
    await alertsService.evaluateAll();
    expect(mockWebhookDeliver).not.toHaveBeenCalled();
  });
});
