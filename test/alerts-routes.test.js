'use strict';

const adminApiKey = 'a'.repeat(64);
process.env.ADMIN_API_KEY = adminApiKey;

const mockZSets = new Map();

const mockRedis = {
  smembers: jest.fn(async () => []),
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
    const z = mockZSets.get(key);
    if (!z) return [];
    const sorted = [...z.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
    const end = stop === -1 ? sorted.length : stop + 1;
    return sorted.slice(start, end);
  }),
  zcard: jest.fn(async (key) => (mockZSets.get(key)?.size || 0)),
};

jest.mock('../src/services/cache', () => ({
  getClient: () => mockRedis,
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  disconnect: jest.fn(),
  isConnected: jest.fn(() => false),
}));

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const request = require('supertest');

const { app, server } = require('../src');
const priceRefreshJob = require('../src/jobs/priceRefresh');


describe('GET /api/v1/alerts pagination', () => {

  afterAll((done) => {
    priceRefreshJob.stop();
    server.close(done);
  });


  test('returns pagination envelope', async () => {

    const response = await request(app)
      .get('/api/v1/alerts')
      .set('Authorization', `Bearer ${adminApiKey}`);


    expect(response.statusCode).toBe(200);

    expect(response.body).toHaveProperty('data');

    expect(response.body).toHaveProperty('pagination');

    expect(response.body.pagination).toHaveProperty('page');

    expect(response.body.pagination).toHaveProperty('limit');

  });

});
