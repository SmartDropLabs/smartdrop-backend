'use strict';

const request = require('supertest');

describe('GET /health', () => {
  test('includes price_source_circuits with an entry per source that has a circuit breaker', async () => {
    jest.resetModules();
    const { app } = require('../src/index');

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.price_source_circuits)).toBe(true);

    const sourceNames = res.body.price_source_circuits.map((c) => c.source);
    expect(sourceNames).toEqual(expect.arrayContaining(['coingecko', 'coinmarketcap']));

    // stellar_dex has no API-key/auth failure mode, so it has no circuit entry.
    expect(sourceNames).not.toContain('stellar_dex');
  });

  test('every circuit starts closed with a null openUntil', async () => {
    jest.resetModules();
    const { app } = require('../src/index');

    const res = await request(app).get('/health');

    for (const circuit of res.body.price_source_circuits) {
      expect(circuit.open).toBe(false);
      expect(circuit.openUntil).toBeNull();
    }
  });
});
