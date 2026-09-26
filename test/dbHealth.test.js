'use strict';

/**
 * Unit tests for the database health probe (issue #376).
 *
 * The probe is tested through its injected `ping` for the states it has to
 * report, and once through a mocked `pg` to prove the default probe actually
 * opens a connection, runs `SELECT 1` and closes it.
 */

const mockClientInstances = [];

jest.mock('../src/config', () => ({
  databaseUrl: 'postgres://smartdrop:secret@localhost:5432/smartdrop_test',
}));

jest.mock('pg', () => ({
  Client: jest.fn().mockImplementation((clientConfig) => {
    const client = {
      clientConfig,
      connect: jest.fn(async () => {}),
      query: jest.fn(async () => ({ rows: [{ '?column?': 1 }] })),
      end: jest.fn(async () => {}),
    };
    mockClientInstances.push(client);
    return client;
  }),
}));

const { Client } = require('pg');
const { checkDatabase, DEFAULT_TIMEOUT_MS } = require('../src/services/dbHealth');

beforeEach(() => {
  jest.clearAllMocks();
  mockClientInstances.length = 0;
});

describe('checkDatabase – configured database', () => {
  test('reports ok with a latency when the ping succeeds', async () => {
    const result = await checkDatabase({ ping: async () => {} });

    expect(result.configured).toBe(true);
    expect(result.checked).toBe(true);
    expect(result.status).toBe('ok');
    expect(typeof result.latency_ms).toBe('number');
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  test('reports error with the reason instead of throwing when the ping fails', async () => {
    const result = await checkDatabase({
      ping: async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:5432');
      },
    });

    expect(result.status).toBe('error');
    expect(result.checked).toBe(true);
    expect(result.error).toBe('ECONNREFUSED 127.0.0.1:5432');
  });

  test('reports error when the ping hangs past the timeout, and resolves anyway', async () => {
    const neverSettles = () => new Promise(() => {});
    const startedAt = Date.now();

    const result = await checkDatabase({ ping: neverSettles, timeoutMs: 50 });
    const elapsed = Date.now() - startedAt;

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/timed out after 50ms/);
    // The endpoint must answer on its own terms, not the database's.
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('checkDatabase – no database configured', () => {
  test('reports unavailable and never runs a probe', async () => {
    jest.resetModules();
    jest.doMock('../src/config', () => ({ databaseUrl: null }));

    const { checkDatabase: checkWithoutDatabase } = require('../src/services/dbHealth');
    const ping = jest.fn();

    const result = await checkWithoutDatabase({ ping });

    expect(result).toEqual({ configured: false, checked: false, status: 'unavailable' });
    expect(ping).not.toHaveBeenCalled();

    jest.dontMock('../src/config');
    jest.resetModules();
  });
});

describe('defaultPing – the real probe', () => {
  test('connects to the configured URL, runs SELECT 1 and closes the connection', async () => {
    const result = await checkDatabase();

    expect(result.status).toBe('ok');
    expect(Client).toHaveBeenCalledTimes(1);
    expect(mockClientInstances).toHaveLength(1);

    const [client] = mockClientInstances;
    expect(client.clientConfig.connectionString).toBe(
      'postgres://smartdrop:secret@localhost:5432/smartdrop_test',
    );
    expect(client.clientConfig.connectionTimeoutMillis).toBe(DEFAULT_TIMEOUT_MS);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith('SELECT 1');
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  test('closes the connection even when the query fails', async () => {
    Client.mockImplementationOnce((clientConfig) => {
      const client = {
        clientConfig,
        connect: jest.fn(async () => {}),
        query: jest.fn(async () => {
          throw new Error('relation does not exist');
        }),
        end: jest.fn(async () => {}),
      };
      mockClientInstances.push(client);
      return client;
    });

    const result = await checkDatabase();

    expect(result.status).toBe('error');
    expect(result.error).toBe('relation does not exist');
    expect(mockClientInstances[0].end).toHaveBeenCalledTimes(1);
  });
});
