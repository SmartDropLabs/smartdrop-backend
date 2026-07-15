'use strict';

process.env.ADMIN_API_KEY = 'a'.repeat(64);

const crypto = require('crypto');

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

jest.mock('../src/services/cache', () => ({
  getClient: () => mockRedis,
  get: jest.fn(async (key) => {
    const v = mockStore.get(key);
    return v !== undefined ? JSON.parse(JSON.stringify(v)) : null;
  }),
  set: jest.fn(async (key, value) => {
    mockStore.set(key, JSON.parse(JSON.stringify(value)));
  }),
  del: jest.fn(async (key) => {
    mockStore.delete(key);
  }),
}));

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const { requireApiKey } = require('../src/middleware/auth');
const keysRouter = require('../src/routes/keys');
const apiKeys = require('../src/services/apiKeys');
const cache = require('../src/services/cache');
const { errorHandler } = require('../src/middleware/errorHandler');

function buildProtectedApp(options) {
  const app = express();
  app.use(express.json());
  app.get('/protected', requireApiKey(options), (req, res) => {
    res.json({ ok: true, key: req.apiKey });
  });
  app.use(errorHandler);
  return app;
}

function buildKeysApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', keysRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  mockStore.clear();
  mockSets.clear();
  cache.get.mockClear();
  cache.set.mockClear();
  cache.del.mockClear();
  mockRedis.smembers.mockClear();
  mockRedis.sadd.mockClear();
  mockRedis.srem.mockClear();
});

describe('requireApiKey middleware', () => {
  test('missing API key returns consistent 401 body', async () => {
    const app = buildProtectedApp();
    const res = await request(app).get('/protected');

    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'UNAUTHORIZED', message: 'Missing or invalid API key' });
  });

  test('invalid API key returns consistent 401 body', async () => {
    const app = buildProtectedApp();
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer bad-key');

    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'UNAUTHORIZED', message: 'Missing or invalid API key' });
  });

  test('ADMIN_API_KEY authenticates bootstrap admin requests', async () => {
    const app = buildProtectedApp({ scopes: ['admin'] });
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${process.env.ADMIN_API_KEY}`);

    expect(res.status).toBe(200);
    expect(res.body.key.id).toBe('admin');
    expect(res.body.key.scopes).toContain('admin');
  });

  test('ADMIN_API_KEY comparison uses timingSafeEqual on fixed-length digests', async () => {
    const timingSpy = jest.spyOn(crypto, 'timingSafeEqual');

    try {
      const result = await apiKeys.validateApiKey(process.env.ADMIN_API_KEY);

      expect(result.id).toBe('admin');
      expect(timingSpy).toHaveBeenCalledTimes(1);
      const [actualDigest, expectedDigest] = timingSpy.mock.calls[0];
      expect(Buffer.isBuffer(actualDigest)).toBe(true);
      expect(Buffer.isBuffer(expectedDigest)).toBe(true);
      expect(actualDigest).toHaveLength(32);
      expect(expectedDigest).toHaveLength(32);
    } finally {
      timingSpy.mockRestore();
    }
  });

  test('wrong-length admin API key guesses do not throw before constant-time comparison', async () => {
    const timingSpy = jest.spyOn(crypto, 'timingSafeEqual');

    try {
      await expect(apiKeys.validateApiKey('short')).resolves.toBeNull();

      expect(timingSpy).toHaveBeenCalledTimes(1);
      const [actualDigest, expectedDigest] = timingSpy.mock.calls[0];
      expect(actualDigest).toHaveLength(32);
      expect(expectedDigest).toHaveLength(32);
    } finally {
      timingSpy.mockRestore();
    }
  });

  test('generated API key authenticates and updates last_used_at', async () => {
    const created = await apiKeys.createKey({ label: 'alerts worker', scopes: ['alerts'] });
    const app = buildProtectedApp();

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${created.api_key}`);

    expect(res.status).toBe(200);
    const stored = await apiKeys.getKey(created.key.id);
    expect(stored.last_used_at).toEqual(expect.any(String));
  });
});

describe('API key management routes', () => {
  test('admin can create, list, and revoke API keys without persisting raw key', async () => {
    const app = buildKeysApp();

    const createRes = await request(app)
      .post('/api/v1/keys')
      .set('Authorization', `Bearer ${process.env.ADMIN_API_KEY}`)
      .send({ label: 'alerts worker', scopes: ['alerts'] });

    expect(createRes.status).toBe(201);
    expect(createRes.body.api_key).toMatch(/^[a-f0-9]{64}$/);
    expect(createRes.body.key).toMatchObject({
      label: 'alerts worker',
      scopes: ['alerts'],
      last_used_at: null,
    });
    expect(createRes.body.key.key_hash).toBeUndefined();

    const stored = [...mockStore.values()].map((value) => JSON.stringify(value)).join('\n');
    expect(stored).not.toContain(createRes.body.api_key);
    expect(stored).toContain(apiKeys.hashApiKey(createRes.body.api_key));

    const listRes = await request(app)
      .get('/api/v1/keys')
      .set('Authorization', `Bearer ${process.env.ADMIN_API_KEY}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.keys).toHaveLength(1);
    expect(listRes.body.keys[0].key_hash).toBeUndefined();

    const deleteRes = await request(app)
      .delete(`/api/v1/keys/${createRes.body.key.id}`)
      .set('Authorization', `Bearer ${process.env.ADMIN_API_KEY}`);

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.deleted).toBe(true);
    expect(await apiKeys.getKey(createRes.body.key.id)).toBeNull();
  });

  test('key management routes require admin API key', async () => {
    const app = buildKeysApp();
    const res = await request(app).get('/api/v1/keys');

    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'UNAUTHORIZED', message: 'Missing or invalid API key' });
  });

  test('create key rejects blank labels', async () => {
    const app = buildKeysApp();
    const res = await request(app)
      .post('/api/v1/keys')
      .set('Authorization', `Bearer ${process.env.ADMIN_API_KEY}`)
      .send({ label: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'label must be a non-empty string up to 80 characters',
    });
  });
});
