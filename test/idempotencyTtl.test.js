'use strict';

/**
 * Idempotency keys expire (#622). Every stored response must be written with
 * the 24h TTL so Redis reclaims it; a key written without a TTL would live
 * forever and grow storage without bound.
 */

jest.mock('../src/services/cache', () => ({
  get: jest.fn(),
  set: jest.fn(),
}));
jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const cache = require('../src/services/cache');
const {
  storeIdempotencyResponse,
  idempotencyMiddleware,
} = require('../src/services/idempotency');

const DAY_SECONDS = 24 * 60 * 60;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('idempotency key expiry (#622)', () => {
  test('storeIdempotencyResponse always writes with the 24h TTL', async () => {
    await storeIdempotencyResponse('abc', 201, { id: 1 });

    expect(cache.set).toHaveBeenCalledTimes(1);
    const [key, value, ttl] = cache.set.mock.calls[0];
    expect(key).toBe('idempotency:abc');
    expect(value).toMatchObject({ statusCode: 201, body: { id: 1 } });
    expect(ttl).toBe(DAY_SECONDS);
  });

  test('responses cached by the middleware carry the TTL too', async () => {
    cache.get.mockResolvedValue(null);
    const middleware = idempotencyMiddleware('webhook');
    const req = { get: () => 'key-1', id: 'req-1' };
    const res = {
      statusCode: 201,
      set: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    res.json({ created: true });

    expect(cache.set).toHaveBeenCalledWith(
      'idempotency:key-1',
      expect.objectContaining({ statusCode: 201 }),
      DAY_SECONDS,
    );
  });

  test('failed responses are not cached at all', async () => {
    cache.get.mockResolvedValue(null);
    const middleware = idempotencyMiddleware();
    const res = { statusCode: 500, set: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };

    await middleware({ get: () => 'key-2', id: 'r' }, res, jest.fn());
    res.json({ error: 'boom' });

    expect(cache.set).not.toHaveBeenCalled();
  });
});
