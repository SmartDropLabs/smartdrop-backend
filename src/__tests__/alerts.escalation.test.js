'use strict';

// Escalation tests for services/alerts.js (issue #689).
// cache, webhook and logger are mocked so no Redis or HTTP is needed.

const mockStore = new Map();
const mockSets = new Map();
const mockZSets = new Map();
const mockLocks = new Map();

const mockRedis = {
  zrevrange: jest.fn(async (key, start, stop) => {
    const z = mockZSets.get(key);
    if (!z) return [];
    const sorted = [...z.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
    const end = stop === -1 ? sorted.length : stop + 1;
    return sorted.slice(start, end);
  }),
  zcard: jest.fn(async (key) => mockZSets.get(key)?.size || 0),
  // Emulates ioredis `SET key val EX ttl NX`: resolves 'OK' only if absent.
  set: jest.fn(async (key, value, ...opts) => {
    if (opts.includes('NX')) {
      if (mockLocks.has(key)) return null;
      mockLocks.set(key, value);
      return 'OK';
    }
    return 'OK';
  }),
  del: jest.fn(async (key) => {
    mockLocks.delete(key);
    return 1;
  }),
};

jest.mock('../services/cache', () => ({
  getClient: jest.fn(() => mockRedis),
  get: jest.fn(async (key) => (mockStore.has(key) ? mockStore.get(key) : null)),
  set: jest.fn(async (key, value) => {
    mockStore.set(key, value);
  }),
  mget: jest.fn(async (keys) => keys.map((k) => (mockStore.has(k) ? mockStore.get(k) : null))),
}));

jest.mock('../services/webhook', () => ({
  deliver: jest.fn(async () => true),
}));

jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const cache = require('../services/cache');
const webhook = require('../services/webhook');
const alerts = require('../services/alerts');

const IDS_KEY = 'alerts:ids';
const TIMEOUT = alerts.ESCALATION_TIMEOUT_MS;
const CREATED = Date.parse('2026-11-01T00:00:00.000Z');

function seedAlert(overrides = {}) {
  const alert = {
    id: 'alrt_test0000000001',
    asset: 'BTC',
    type: 'above',
    threshold_usd: 100,
    webhook_url: 'https://hooks.example.test/a',
    webhook_secret: 'secret',
    repeat: false,
    owner_ip: null,
    created_at: new Date(CREATED).toISOString(),
    last_fired_at: null,
    baseline_price: null,
    acknowledged: false,
    acknowledged_at: null,
    escalated_at: null,
    ...overrides,
  };
  mockStore.set(`alert:${alert.id}`, alert);
  mockZSets.set(IDS_KEY, (mockZSets.get(IDS_KEY) || new Map()).set(alert.id, CREATED));
  return alert;
}

beforeEach(() => {
  mockStore.clear();
  mockSets.clear();
  mockZSets.clear();
  mockLocks.clear();
  jest.clearAllMocks();
});

describe('ESCALATION_TIMEOUT_MS config (#689)', () => {
  it('defaults to 15 minutes', () => {
    if (process.env.ALERT_ESCALATION_TIMEOUT_MS === undefined) {
      expect(TIMEOUT).toBe(15 * 60 * 1000);
    } else {
      expect(TIMEOUT).toBe(parseInt(process.env.ALERT_ESCALATION_TIMEOUT_MS, 10));
    }
  });
});

describe('isEscalationDue', () => {
  it('is false before the timeout elapses', () => {
    const alert = seedAlert();
    expect(alerts.isEscalationDue(alert, CREATED + TIMEOUT - 1)).toBe(false);
  });

  it('is true once the timeout has elapsed for an unacknowledged alert', () => {
    const alert = seedAlert();
    expect(alerts.isEscalationDue(alert, CREATED + TIMEOUT + 1)).toBe(true);
  });

  it('is false for acknowledged or already escalated alerts', () => {
    expect(alerts.isEscalationDue(seedAlert({ acknowledged: true }), CREATED + TIMEOUT + 1)).toBe(false);
    expect(
      alerts.isEscalationDue(seedAlert({ escalated_at: '2026-11-01T01:00:00.000Z' }), CREATED + TIMEOUT + 1)
    ).toBe(false);
  });

  it('is false for a missing or unparseable created_at', () => {
    expect(alerts.isEscalationDue({ id: 'x', created_at: 'not-a-date' }, Date.now() + TIMEOUT * 2)).toBe(false);
    expect(alerts.isEscalationDue(null, Date.now())).toBe(false);
  });
});

describe('acknowledge', () => {
  it('marks the alert acknowledged and persists it', async () => {
    const alert = seedAlert();
    const updated = await alerts.acknowledge(alert.id);
    expect(updated.acknowledged).toBe(true);
    expect(updated.acknowledged_at).toEqual(expect.any(String));
    expect(mockStore.get(`alert:${alert.id}`).acknowledged).toBe(true);
  });

  it('returns null for an unknown alert', async () => {
    expect(await alerts.acknowledge('alrt_missing')).toBeNull();
  });
});

describe('escalateAlert', () => {
  it('delivers an alert.escalated webhook and records escalated_at', async () => {
    const alert = seedAlert();
    const result = await alerts.escalateAlert(alert);
    expect(result).toBe(true);
    expect(webhook.deliver).toHaveBeenCalledTimes(1);
    const [url, secret, payload] = webhook.deliver.mock.calls[0];
    expect(url).toBe(alert.webhook_url);
    expect(secret).toBe(alert.webhook_secret);
    expect(payload.event).toBe('alert.escalated');
    expect(payload.alert_id).toBe(alert.id);
    expect(mockStore.get(`alert:${alert.id}`).escalated_at).toEqual(expect.any(String));
  });

  it('does not escalate the same alert twice (durable escalated_at marker)', async () => {
    const alert = seedAlert();
    expect(await alerts.escalateAlert(alert)).toBe(true);
    // Lock is released or expired in production; even with a free lock the
    // stored escalated_at must stop a second delivery.
    mockLocks.clear();
    expect(await alerts.escalateAlert(alert)).toBe(false);
    expect(webhook.deliver).toHaveBeenCalledTimes(1);
  });

  it('skips delivery when another worker holds the escalation lock', async () => {
    const alert = seedAlert();
    mockLocks.set(`alert:escalation-lock:${alert.id}`, '1');
    expect(await alerts.escalateAlert(alert)).toBe(false);
    expect(webhook.deliver).not.toHaveBeenCalled();
  });

  it('does not escalate an alert acknowledged after it was read', async () => {
    const alert = seedAlert();
    mockStore.set(`alert:${alert.id}`, { ...alert, acknowledged: true });
    expect(await alerts.escalateAlert(alert)).toBe(false);
    expect(webhook.deliver).not.toHaveBeenCalled();
  });

  it('releases the lock and rethrows when delivery fails, so a later pass can retry', async () => {
    const alert = seedAlert();
    webhook.deliver.mockRejectedValueOnce(new Error('boom'));
    await expect(alerts.escalateAlert(alert)).rejects.toThrow('boom');
    expect(mockLocks.has(`alert:escalation-lock:${alert.id}`)).toBe(false);
    expect(mockStore.get(`alert:${alert.id}`).escalated_at).toBeNull();

    expect(await alerts.escalateAlert(alert)).toBe(true);
    expect(webhook.deliver).toHaveBeenCalledTimes(2);
  });
});

describe('evaluateEscalations', () => {
  it('escalates only unacknowledged alerts past the timeout', async () => {
    seedAlert({ id: 'alrt_old_unacked' });
    seedAlert({ id: 'alrt_old_acked', acknowledged: true });
    seedAlert({ id: 'alrt_already', escalated_at: '2026-11-01T01:00:00.000Z' });
    const young = seedAlert({ id: 'alrt_young' });
    mockStore.set(`alert:${young.id}`, { ...young, created_at: new Date(Date.now()).toISOString() });

    const count = await alerts.evaluateEscalations({ now: CREATED + TIMEOUT + 1 });

    expect(count).toBe(1);
    expect(webhook.deliver).toHaveBeenCalledTimes(1);
    expect(webhook.deliver.mock.calls[0][2].alert_id).toBe('alrt_old_unacked');
  });

  it('is idempotent across repeated passes', async () => {
    seedAlert({ id: 'alrt_once' });
    const now = CREATED + TIMEOUT + 1;
    expect(await alerts.evaluateEscalations({ now })).toBe(1);
    mockLocks.clear();
    expect(await alerts.evaluateEscalations({ now })).toBe(0);
    expect(webhook.deliver).toHaveBeenCalledTimes(1);
  });

  it('keeps going when one alert fails to deliver', async () => {
    seedAlert({ id: 'alrt_fail' });
    seedAlert({ id: 'alrt_ok' });
    webhook.deliver.mockRejectedValueOnce(new Error('down'));
    const count = await alerts.evaluateEscalations({ now: CREATED + TIMEOUT + 1 });
    expect(count).toBe(1);
    expect(webhook.deliver).toHaveBeenCalledTimes(2);
  });

  it('returns 0 when there are no alerts', async () => {
    expect(await alerts.evaluateEscalations()).toBe(0);
    expect(webhook.deliver).not.toHaveBeenCalled();
  });
});

describe('existing API is unchanged', () => {
  it('still exports the original functions', () => {
    for (const name of [
      'create', 'get', 'list', 'listPaginated', 'remove', 'evaluateForAsset',
      'evaluateAll', 'backfillAssetIndex', 'fire', 'isDuplicateAlert', 'getAlertDedupKey',
    ]) {
      expect(typeof alerts[name]).toBe('function');
    }
    expect(alerts.DEDUP_WINDOW_SECONDS).toBe(300);
  });
});
