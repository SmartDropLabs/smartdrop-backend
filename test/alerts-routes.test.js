'use strict';

const adminApiKey = 'a'.repeat(64);
process.env.ADMIN_API_KEY = adminApiKey;

const mockStore = new Map();
const mockSortedSets = new Map();

const mockRedis = {
  smembers: jest.fn(async () => []),
  zadd: jest.fn(async (key, score, member) => {
    if (!mockSortedSets.has(key)) mockSortedSets.set(key, new Map());
    mockSortedSets.get(key).set(member, score);
  }),
  zrem: jest.fn(async (key, member) => {
    mockSortedSets.get(key)?.delete(member);
  }),
  zcard: jest.fn(async (key) => mockSortedSets.get(key)?.size || 0),
  zrevrange: jest.fn(async (key, start, stop) => {
    const sortedSet = mockSortedSets.get(key);
    if (!sortedSet) return [];
    const entries = Array.from(sortedSet.entries()).sort((a, b) => b[1] - a[1]);
    const startIdx = start === -1 ? entries.length + start : start;
    const stopIdx = stop === -1 ? entries.length + stop : stop;
    return entries.slice(startIdx, stopIdx + 1).map(([member]) => member);
  }),
};

jest.mock('../src/services/cache', () => ({
  getClient: () => mockRedis,
  get: jest.fn(async (key) => mockStore.get(key) || null),
  set: jest.fn(async (key, value) => mockStore.set(key, value)),
  del: jest.fn(async (key) => mockStore.delete(key)),
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

beforeEach(() => {
  mockStore.clear();
  mockSortedSets.clear();
});


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
