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

  test('list returns all created webhooks', async () => {
    await webhookRepo.create({ url: 'https://a.com', events: ['*'], secret: 'whsec_aaaaaaaaaaaaaaaa' });
    await webhookRepo.create({ url: 'https://b.com', events: ['*'], secret: 'whsec_bbbbbbbbbbbbbbbb' });
    const all = await webhookRepo.list();
    expect(all).toHaveLength(2);
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
    expect(await webhookRepo.list()).toHaveLength(0);
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
});
