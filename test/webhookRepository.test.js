'use strict';

const { createCacheMock } = require('./helpers/cacheMock');

const mockHelper = createCacheMock();
const { reset } = mockHelper;

jest.mock('../src/services/cache', () => mockHelper.cacheMock);
jest.mock('../src/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const webhookRepo = require('../src/repositories/webhookRepository');
const events = require('../src/services/webhookEvents');
const { isEncrypted } = require('../src/services/webhookEncryption');

beforeEach(() => reset());

describe('webhookRepository', () => {
  test('create persists a webhook with generated id and active=true', async () => {
    const w = await webhookRepo.create({
      url: 'https://example.com/hook',
      events: ['pool.assets_locked'],
      secret: 'whsec_aaaaaaaaaaaaaaaa',
    });
    expect(w.id).toMatch(/^wh_/);
    expect(w.active).toBe(true);
    expect(w.events).toEqual(['pool.assets_locked']);
  });

  test('findById returns the stored webhook', async () => {
    const created = await webhookRepo.create({
      url: 'https://example.com/hook',
      events: ['*'],
      secret: 'whsec_aaaaaaaaaaaaaaaa',
    });
    const found = await webhookRepo.findById(created.id);
    expect(found.id).toBe(created.id);
  });

  test('findById returns null when missing', async () => {
    expect(await webhookRepo.findById('wh_nope')).toBeNull();
  });

  test('listAll returns every created webhook, unpaginated', async () => {
    await webhookRepo.create({ url: 'https://a.com', events: ['*'], secret: 'whsec_aaaaaaaaaaaaaaaa' });
    await webhookRepo.create({ url: 'https://b.com', events: ['*'], secret: 'whsec_bbbbbbbbbbbbbbbb' });
    const all = await webhookRepo.listAll();
    expect(all).toHaveLength(2);
  });

  test('list returns a paginated { webhooks, total } page (#131)', async () => {
    await webhookRepo.create({ url: 'https://a.com', events: ['*'], secret: 'whsec_aaaaaaaaaaaaaaaa' });
    await webhookRepo.create({ url: 'https://b.com', events: ['*'], secret: 'whsec_bbbbbbbbbbbbbbbb' });
    await webhookRepo.create({ url: 'https://c.com', events: ['*'], secret: 'whsec_cccccccccccccccc' });

    const page1 = await webhookRepo.list(1, 2);
    expect(page1.webhooks).toHaveLength(2);
    expect(page1.total).toBe(3);

    const page2 = await webhookRepo.list(2, 2);
    expect(page2.webhooks).toHaveLength(1);
    expect(page2.total).toBe(3);

    // No overlap between pages.
    const page1Ids = page1.webhooks.map((w) => w.id);
    const page2Ids = page2.webhooks.map((w) => w.id);
    expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false);
  });

  test('update merges patch and bumps updated_at', async () => {
    const w = await webhookRepo.create({ url: 'https://a.com', events: ['*'], secret: 'whsec_aaaaaaaaaaaaaaaa' });
    const updated = await webhookRepo.update(w.id, { active: false });
    expect(updated.active).toBe(false);
    expect(updated.created_at).toBe(w.created_at);
    expect(updated.updated_at >= w.updated_at).toBe(true);
  });

  test('remove deletes and returns the previous record', async () => {
    const w = await webhookRepo.create({ url: 'https://a.com', events: ['*'], secret: 'whsec_aaaaaaaaaaaaaaaa' });
    const removed = await webhookRepo.remove(w.id);
    expect(removed.id).toBe(w.id);
    expect(await webhookRepo.listAll()).toHaveLength(0);
  });

  test('listActiveForEvent filters by subscription and active flag', async () => {
    const a = await webhookRepo.create({ url: 'https://a.com', events: ['pool.assets_locked'], secret: 'whsec_aaaaaaaaaaaaaaaa' });
    const b = await webhookRepo.create({ url: 'https://b.com', events: ['pool.closed'], secret: 'whsec_bbbbbbbbbbbbbbbb' });
    const c = await webhookRepo.create({ url: 'https://c.com', events: ['*'], secret: 'whsec_cccccccccccccccc' });
    await webhookRepo.update(c.id, { active: false });

    const result = await webhookRepo.listActiveForEvent('pool.assets_locked', events.matchesSubscription);
    const ids = result.map((w) => w.id).sort();
    expect(ids).toEqual([a.id].sort());
    expect(ids).not.toContain(b.id);
    expect(ids).not.toContain(c.id);
  });

  describe('secret encryption at rest (#145)', () => {
    test('the secret stored in the backend is encrypted, not the plaintext', async () => {
      const plaintext = 'whsec_plaintextvalue0000000';
      const w = await webhookRepo.create({ url: 'https://a.com', events: ['*'], secret: plaintext });
      const raw = mockHelper.store.get(`webhook:${w.id}`);
      expect(raw.secret).not.toBe(plaintext);
      expect(isEncrypted(raw.secret)).toBe(true);
    });

    test('findById/listAll return the decrypted plaintext secret to callers', async () => {
      const plaintext = 'whsec_plaintextvalue0000001';
      const w = await webhookRepo.create({ url: 'https://a.com', events: ['*'], secret: plaintext });
      expect((await webhookRepo.findById(w.id)).secret).toBe(plaintext);
      expect((await webhookRepo.listAll())[0].secret).toBe(plaintext);
    });

    test('updating the secret re-encrypts the new value at rest', async () => {
      const w = await webhookRepo.create({ url: 'https://a.com', events: ['*'], secret: 'whsec_original00000000000' });
      const rotated = 'whsec_rotatedsecret00000000';
      await webhookRepo.update(w.id, { secret: rotated });

      const raw = mockHelper.store.get(`webhook:${w.id}`);
      expect(raw.secret).not.toBe(rotated);
      expect(isEncrypted(raw.secret)).toBe(true);
      expect((await webhookRepo.findById(w.id)).secret).toBe(rotated);
    });

    test('a patch that does not touch the secret leaves the encrypted value untouched', async () => {
      const w = await webhookRepo.create({ url: 'https://a.com', events: ['*'], secret: 'whsec_untouched000000000' });
      const before = mockHelper.store.get(`webhook:${w.id}`).secret;
      await webhookRepo.update(w.id, { active: false });
      const after = mockHelper.store.get(`webhook:${w.id}`).secret;
      expect(after).toBe(before);
    });

    test('a legacy plaintext-stored record is still read correctly (backward compatibility)', async () => {
      const cache = require('../src/services/cache');
      const legacy = {
        id: 'wh_legacy0000000000000',
        url: 'https://legacy.com',
        events: ['*'],
        secret: 'whsec_neverencrypted00000',
        active: true,
        description: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await cache.set(`webhook:${legacy.id}`, legacy);
      const found = await webhookRepo.findById(legacy.id);
      expect(found.secret).toBe('whsec_neverencrypted00000');
    });
  });

  describe('atomic create (#355)', () => {
    test('create writes the record and its id-set membership in one MULTI/EXEC transaction', async () => {
      const w = await webhookRepo.create({
        url: 'https://a.com',
        events: ['*'],
        secret: 'whsec_aaaaaaaaaaaaaaaa',
        owner_ip: '203.0.113.5',
      });

      expect(mockHelper.redis.multi).toHaveBeenCalledTimes(1);
      // Both the record and both index entries (global + per-owner) must
      // have actually landed — not just that multi() was called.
      expect(await webhookRepo.findById(w.id)).not.toBeNull();
      const all = await webhookRepo.listAll();
      expect(all.map((wh) => wh.id)).toContain(w.id);
      expect(await webhookRepo.countByOwner('203.0.113.5')).toBe(1);
    });

    test('create without owner_ip still commits the record and the global index atomically', async () => {
      const w = await webhookRepo.create({ url: 'https://b.com', events: ['*'], secret: 'whsec_bbbbbbbbbbbbbbbb' });
      expect(mockHelper.redis.multi).toHaveBeenCalledTimes(1);
      expect(await webhookRepo.findById(w.id)).not.toBeNull();
    });
  });

  describe('atomic remove (#356)', () => {
    test('remove drops the record and every index entry in one MULTI/EXEC', async () => {
      const w = await webhookRepo.create({
        url: 'https://a.com',
        events: ['pool.assets_locked'],
        secret: 'whsec_aaaaaaaaaaaaaaaa',
        owner_ip: '203.0.113.5',
      });
      mockHelper.redis.multi.mockClear();

      const removed = await webhookRepo.remove(w.id);

      expect(removed.id).toBe(w.id);
      expect(mockHelper.redis.multi).toHaveBeenCalledTimes(1);
      // The record is gone…
      expect(await webhookRepo.findById(w.id)).toBeNull();
      expect(await webhookRepo.listAll()).toHaveLength(0);
      // …and so is every index it used to appear in, so no index outlives
      // the record as a phantom entry.
      expect(await webhookRepo.countByOwner('203.0.113.5')).toBe(0);
      const eventIndex = mockHelper.sets.get('webhooks:event:pool.assets_locked');
      expect([...(eventIndex || [])]).not.toContain(w.id);
    });

    test('remove keeps the surviving webhooks intact', async () => {
      const keep = await webhookRepo.create({
        url: 'https://keep.com',
        events: ['pool.assets_locked'],
        secret: 'whsec_aaaaaaaaaaaaaaaa',
        owner_ip: '203.0.113.5',
      });
      const drop = await webhookRepo.create({
        url: 'https://drop.com',
        events: ['pool.assets_locked'],
        secret: 'whsec_bbbbbbbbbbbbbbbb',
        owner_ip: '203.0.113.5',
      });

      await webhookRepo.remove(drop.id);

      expect((await webhookRepo.listAll()).map((entry) => entry.id)).toEqual([keep.id]);
      expect(await webhookRepo.countByOwner('203.0.113.5')).toBe(1);
      expect([...(mockHelper.sets.get('webhooks:event:pool.assets_locked') || [])]).toEqual([keep.id]);
    });

    test('remove of a missing webhook returns null without issuing a transaction', async () => {
      mockHelper.redis.multi.mockClear();

      expect(await webhookRepo.remove('wh_missing')).toBeNull();
      expect(mockHelper.redis.multi).not.toHaveBeenCalled();
    });
  });

  describe('batched listAll (#357)', () => {
    test('hydrates every webhook with a single MGET round trip', async () => {
      for (const host of ['a', 'b', 'c']) {
        await webhookRepo.create({ url: `https://${host}.com`, events: ['*'], secret: 'whsec_aaaaaaaaaaaaaaaa' });
      }
      mockHelper.redis.mget.mockClear();
      mockHelper.redis.get.mockClear();

      const all = await webhookRepo.listAll();

      expect(all.map((entry) => entry.url).sort()).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
      expect(mockHelper.redis.mget).toHaveBeenCalledTimes(1);
      expect(mockHelper.redis.mget.mock.calls[0]).toHaveLength(3);
      // No per-record GET round trips left behind.
      expect(mockHelper.redis.get).not.toHaveBeenCalled();
    });

    test('returns [] for no webhooks without reading any record keys', async () => {
      mockHelper.redis.mget.mockClear();

      expect(await webhookRepo.listAll()).toEqual([]);
      expect(mockHelper.redis.mget).not.toHaveBeenCalled();
    });

    test('drops index entries whose record already expired, and decrypts the rest', async () => {
      const plaintext = 'whsec_plaintextvalue0000002';
      const w = await webhookRepo.create({ url: 'https://a.com', events: ['*'], secret: plaintext });
      // An index id whose backing record is gone must be skipped rather than
      // surfaced as a null hole in the fan-out list.
      mockHelper.redis.zrevrange.mockImplementationOnce(async () => [w.id, 'wh_expired00000000000']);

      const all = await webhookRepo.listAll();

      expect(all).toHaveLength(1);
      expect(all[0].secret).toBe(plaintext);
    });
  });
});
