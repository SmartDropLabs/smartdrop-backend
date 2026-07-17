'use strict';

const request = require('supertest');

// ---------------------------------------------------------------------------
// Helpers – reset modules between tests so mocks are applied cleanly
// ---------------------------------------------------------------------------

function loadApp() {
  return require('../src/index').app;
}

// ---------------------------------------------------------------------------
// GET /health – price_source_circuits (pre-existing behaviour)
// ---------------------------------------------------------------------------

describe('GET /health – price_source_circuits', () => {
  test('includes an entry per source that has a circuit breaker', async () => {
    jest.resetModules();
    const app = loadApp();

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.price_source_circuits)).toBe(true);

    const sourceNames = res.body.price_source_circuits.map((c) => c.source);
    expect(sourceNames).toEqual(expect.arrayContaining(['coingecko', 'coinmarketcap']));
    expect(sourceNames).not.toContain('stellar_dex');
  });

  test('every circuit starts closed with a null openUntil', async () => {
    jest.resetModules();
    const app = loadApp();

    const res = await request(app).get('/health');

    for (const circuit of res.body.price_source_circuits) {
      expect(circuit.open).toBe(false);
      expect(circuit.openUntil).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /health – overall response shape
// ---------------------------------------------------------------------------

describe('GET /health – response shape', () => {
  test('returns expected top-level fields', async () => {
    jest.resetModules();
    const app = loadApp();

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('timestamp');
    expect(res.body).toHaveProperty('redis');
    expect(res.body).toHaveProperty('jobs');
    expect(res.body).toHaveProperty('database');
    expect(res.body).toHaveProperty('price_source_circuits');
  });

  test('database field reflects configured-but-unused state', async () => {
    jest.resetModules();
    const app = loadApp();

    const res = await request(app).get('/health');

    expect(res.body.database).toEqual({
      configured: true,
      checked: false,
      status: 'unused',
    });
  });

  test('jobs field contains price_refresh and webhook_retry_worker entries', async () => {
    jest.resetModules();
    const app = loadApp();

    const res = await request(app).get('/health');

    expect(res.body.jobs).toHaveProperty('price_refresh');
    expect(res.body.jobs).toHaveProperty('webhook_retry_worker');

    for (const key of ['price_refresh', 'webhook_retry_worker']) {
      const job = res.body.jobs[key];
      expect(job).toHaveProperty('healthy');
      expect(job).toHaveProperty('last_success_at');
      expect(job).toHaveProperty('last_error');
      expect(job).toHaveProperty('stalled');
    }
  });
});

// ---------------------------------------------------------------------------
// GET /health – status computation
// ---------------------------------------------------------------------------

describe('GET /health – status computation', () => {
  test('status is ok when Redis is connected and jobs are healthy', async () => {
    jest.resetModules();

    jest.mock('../src/services/cache', () => ({
      isConnected: () => true,
      disconnect: jest.fn(),
    }));
    jest.mock('../src/jobs/priceRefresh', () => ({
      start: jest.fn(),
      stop: jest.fn(),
      getHealth: () => ({ healthy: true, lastSuccessAt: Date.now(), lastError: null, stalled: false }),
    }));
    jest.mock('../src/jobs/webhookRetryWorker', () => ({
      start: jest.fn(),
      stop: jest.fn(),
      tick: jest.fn(),
      getHealth: () => ({ healthy: true, lastSuccessAt: Date.now(), lastError: null, stalled: false }),
    }));

    const app = loadApp();
    const res = await request(app).get('/health');

    expect(res.body.status).toBe('ok');
  });

  test('status is unhealthy when Redis is disconnected', async () => {
    jest.resetModules();

    jest.mock('../src/services/cache', () => ({
      isConnected: () => false,
      disconnect: jest.fn(),
    }));
    jest.mock('../src/jobs/priceRefresh', () => ({
      start: jest.fn(),
      stop: jest.fn(),
      getHealth: () => ({ healthy: true, lastSuccessAt: Date.now(), lastError: null, stalled: false }),
    }));
    jest.mock('../src/jobs/webhookRetryWorker', () => ({
      start: jest.fn(),
      stop: jest.fn(),
      tick: jest.fn(),
      getHealth: () => ({ healthy: true, lastSuccessAt: Date.now(), lastError: null, stalled: false }),
    }));

    const app = loadApp();
    const res = await request(app).get('/health');

    expect(res.body.status).toBe('unhealthy');
    expect(res.body.redis.connected).toBe(false);
  });

  test('status is unhealthy when a job is stalled', async () => {
    jest.resetModules();

    jest.mock('../src/services/cache', () => ({
      isConnected: () => true,
      disconnect: jest.fn(),
    }));
    jest.mock('../src/jobs/priceRefresh', () => ({
      start: jest.fn(),
      stop: jest.fn(),
      getHealth: () => ({ healthy: false, lastSuccessAt: null, lastError: 'timeout', stalled: true }),
    }));
    jest.mock('../src/jobs/webhookRetryWorker', () => ({
      start: jest.fn(),
      stop: jest.fn(),
      tick: jest.fn(),
      getHealth: () => ({ healthy: true, lastSuccessAt: Date.now(), lastError: null, stalled: false }),
    }));

    const app = loadApp();
    const res = await request(app).get('/health');

    expect(res.body.status).toBe('unhealthy');
    expect(res.body.jobs.price_refresh.stalled).toBe(true);
    expect(res.body.jobs.price_refresh.last_error).toBe('timeout');
  });

  test('status is degraded during startup grace period (job not yet run)', async () => {
    jest.resetModules();

    jest.mock('../src/services/cache', () => ({
      isConnected: () => true,
      disconnect: jest.fn(),
    }));
    jest.mock('../src/jobs/priceRefresh', () => ({
      start: jest.fn(),
      stop: jest.fn(),
      // healthy=false, stalled=false → still in grace period
      getHealth: () => ({ healthy: false, lastSuccessAt: null, lastError: null, stalled: false }),
    }));
    jest.mock('../src/jobs/webhookRetryWorker', () => ({
      start: jest.fn(),
      stop: jest.fn(),
      tick: jest.fn(),
      getHealth: () => ({ healthy: true, lastSuccessAt: Date.now(), lastError: null, stalled: false }),
    }));

    const app = loadApp();
    const res = await request(app).get('/health');

    expect(res.body.status).toBe('degraded');
  });

  test('overall status is never ok when any dependency is unhealthy', async () => {
    jest.resetModules();

    jest.mock('../src/services/cache', () => ({
      isConnected: () => false,
      disconnect: jest.fn(),
    }));
    jest.mock('../src/jobs/priceRefresh', () => ({
      start: jest.fn(),
      stop: jest.fn(),
      getHealth: () => ({ healthy: false, lastSuccessAt: null, lastError: 'err', stalled: true }),
    }));
    jest.mock('../src/jobs/webhookRetryWorker', () => ({
      start: jest.fn(),
      stop: jest.fn(),
      tick: jest.fn(),
      getHealth: () => ({ healthy: false, lastSuccessAt: null, lastError: 'err', stalled: true }),
    }));

    const app = loadApp();
    const res = await request(app).get('/health');

    expect(res.body.status).not.toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// priceRefresh.getHealth() – unit tests for grace-period logic
// ---------------------------------------------------------------------------

describe('priceRefresh.getHealth() – grace period', () => {
  test('returns healthy=false and stalled=false before start() is called', () => {
    // Load the real module, bypassing any jest.mock registrations from prior tests
    const job = jest.requireActual('../src/jobs/priceRefresh');
    // Reset internal state by reloading via isolateModules
    let freshJob;
    jest.isolateModules(() => {
      jest.unmock('../src/jobs/priceRefresh');
      freshJob = require('../src/jobs/priceRefresh');
    });
    const h = freshJob.getHealth();
    expect(h.healthy).toBe(false);
    expect(h.stalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// webhookRetryWorker.getHealth() – unit tests for grace-period logic
// ---------------------------------------------------------------------------

describe('webhookRetryWorker.getHealth() – grace period', () => {
  test('returns healthy=false and stalled=false before start() is called', () => {
    let freshWorker;
    jest.isolateModules(() => {
      jest.unmock('../src/jobs/webhookRetryWorker');
      freshWorker = require('../src/jobs/webhookRetryWorker');
    });
    const h = freshWorker.getHealth();
    expect(h.healthy).toBe(false);
    expect(h.stalled).toBe(false);
  });
});
