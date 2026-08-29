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
    mockStore.set(`alert:cooldown:${alert.asset}`, sixMinutesAgo);

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

  test('evaluates multiple assets independently', async () => {
    mockStore.set('price:XLM', { price: 0.08 });
    mockStore.set('price:BTC', { price: 50000 });
    await makeAlert({ asset: 'XLM', threshold_usd: 0.09, repeat: true });
    await makeAlert({ asset: 'BTC', threshold_usd: 40000, type: 'above', repeat: true });
    await alertsService.evaluateAll();
    expect(mockWebhookDeliver).toHaveBeenCalledTimes(2);
  });
});

describe('listPaginated', () => {
  test('returns empty result when no alerts exist', async () => {
    const result = await alertsService.listPaginated({ offset: 0, limit: 10 });
    expect(result.alerts).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  test('returns paginated subset of alerts', async () => {
    await makeAlert({ threshold_usd: 0.01 });
    await makeAlert({ threshold_usd: 0.02 });
    await makeAlert({ threshold_usd: 0.03 });

    const page1 = await alertsService.listPaginated({ offset: 0, limit: 2 });
    expect(page1.alerts).toHaveLength(2);
    expect(page1.total).toBe(3);

    const page2 = await alertsService.listPaginated({ offset: 2, limit: 2 });
    expect(page2.alerts).toHaveLength(1);
    expect(page2.total).toBe(3);
  });

  test('defaults to offset 0 and limit 20', async () => {
    await makeAlert();
    const result = await alertsService.listPaginated();
    expect(result.alerts).toHaveLength(1);
  });
});

describe('change_pct negative direction', () => {
  test('fires when price drops by >= threshold percent', async () => {
    mockStore.set('price:XLM', { price: 0.10 });
    await makeAlert({ type: 'change_pct', threshold_usd: 10 });
    await alertsService.evaluateForAsset('XLM', 0.089);
    expect(mockWebhookDeliver).toHaveBeenCalledTimes(1);
  });

  test('does not fire for small negative change', async () => {
    mockStore.set('price:XLM', { price: 0.10 });
    await makeAlert({ type: 'change_pct', threshold_usd: 10 });
    await alertsService.evaluateForAsset('XLM', 0.095);
    expect(mockWebhookDeliver).not.toHaveBeenCalled();
  });
});

describe('alert for different asset', () => {
  test('does not trigger alert for non-matching asset', async () => {
    await makeAlert({ asset: 'XLM', threshold_usd: 0.09 });
    await alertsService.evaluateForAsset('BTC', 0.01);
    expect(mockWebhookDeliver).not.toHaveBeenCalled();
  });
});

describe('repeat: true with change_pct', () => {
  test('resets baseline_price after firing', async () => {
    mockStore.set('price:XLM', { price: 0.10 });
    await makeAlert({ type: 'change_pct', threshold_usd: 10, repeat: true });
    await alertsService.evaluateForAsset('XLM', 0.12);
    expect(mockWebhookDeliver).toHaveBeenCalledTimes(1);

    const [alert] = await alertsService.list();
    expect(alert.baseline_price).toBe(0.12);
  });
});

describe('isTriggered edge cases', () => {
  test('above: fires at exactly threshold + epsilon', async () => {
    await makeAlert({ type: 'above', threshold_usd: 1.0 });
    await alertsService.evaluateForAsset('XLM', 1.00001);
    expect(mockWebhookDeliver).toHaveBeenCalledTimes(1);
  });

  test('below: fires at exactly threshold - epsilon', async () => {
    await makeAlert({ type: 'below', threshold_usd: 1.0 });
    await alertsService.evaluateForAsset('XLM', 0.99999);
    expect(mockWebhookDeliver).toHaveBeenCalledTimes(1);
  });

  test('above: does not fire at exactly threshold', async () => {
    await makeAlert({ type: 'above', threshold_usd: 1.0 });
    await alertsService.evaluateForAsset('XLM', 1.0);
    expect(mockWebhookDeliver).not.toHaveBeenCalled();
  });

  test('below: does not fire at exactly threshold', async () => {
    await makeAlert({ type: 'below', threshold_usd: 1.0 });
    await alertsService.evaluateForAsset('XLM', 1.0);
    expect(mockWebhookDeliver).not.toHaveBeenCalled();
  });

  test('unknown type returns false', async () => {
    await makeAlert({ type: 'unknown_type', threshold_usd: 1.0 });
    await alertsService.evaluateForAsset('XLM', 100);
    expect(mockWebhookDeliver).not.toHaveBeenCalled();
  });
});

describe('create normalization', () => {
  test('asset is uppercased', async () => {
    const alert = await makeAlert({ asset: 'xlm' });
    expect(alert.asset).toBe('XLM');
  });

  test('repeat defaults to false when not provided', async () => {
    const alert = await makeAlert({ repeat: undefined });
    expect(alert.repeat).toBe(false);
  });

  test('generates unique IDs for each alert', async () => {
    const a1 = await makeAlert();
    const a2 = await makeAlert();
    expect(a1.id).not.toBe(a2.id);
  });
});

describe('fire payload', () => {
  test('delivers correct payload shape to webhook', async () => {
    await makeAlert({ threshold_usd: 0.09 });
    await alertsService.evaluateForAsset('XLM', 0.05);

    const [url, secret, payload] = mockWebhookDeliver.mock.calls[0];
    expect(url).toBe('https://example.com/hook');
    expect(secret).toBe('whsec_testsecret');
    expect(payload).toMatchObject({
      event: 'price.alert',
      asset: 'XLM',
      type: 'below',
      threshold_usd: 0.09,
      actual_price_usd: 0.05,
    });
    expect(payload.triggered_at).toBeDefined();
  });
});

describe('evaluateForAsset with multiple alerts', () => {
  test('fires all triggered alerts for the same asset', async () => {
    await makeAlert({ threshold_usd: 0.09, webhook_url: 'https://a.com/hook', webhook_secret: 'whsec_a' });
    await makeAlert({ threshold_usd: 0.10, webhook_url: 'https://b.com/hook', webhook_secret: 'whsec_b' });
    await alertsService.evaluateForAsset('XLM', 0.05);
    expect(mockWebhookDeliver).toHaveBeenCalledTimes(2);
  });

  test('only fires alerts matching the queried asset', async () => {
    await makeAlert({ asset: 'XLM', threshold_usd: 0.09 });
    await makeAlert({ asset: 'BTC', threshold_usd: 0.09 });
    await alertsService.evaluateForAsset('XLM', 0.05);
    expect(mockWebhookDeliver).toHaveBeenCalledTimes(1);
    expect(mockWebhookDeliver.mock.calls[0][2].asset).toBe('XLM');
  });

  test('enforces per-asset cooldown for repeat alerts on the same asset', async () => {
    await makeAlert({ repeat: true, threshold_usd: 0.09, webhook_url: 'https://a.com/hook' });
    await makeAlert({ repeat: true, threshold_usd: 0.10, webhook_url: 'https://b.com/hook' });
    await alertsService.evaluateForAsset('XLM', 0.05);
    expect(mockWebhookDeliver).toHaveBeenCalledTimes(1);
  });
});
