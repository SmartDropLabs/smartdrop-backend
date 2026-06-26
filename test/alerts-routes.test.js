'use strict';

const mockRedis = {
  smembers: jest.fn(async () => []),
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
const app = require('../src');


describe('GET /api/v1/alerts pagination', () => {

  test('returns pagination envelope', async () => {

    const response = await request(app)
      .get('/api/v1/alerts');

    expect(response.statusCode).toBe(200);

    expect(response.body).toHaveProperty('data');

    expect(response.body).toHaveProperty('pagination');

    expect(response.body.pagination).toHaveProperty('page');

    expect(response.body.pagination).toHaveProperty('limit');

  });

});