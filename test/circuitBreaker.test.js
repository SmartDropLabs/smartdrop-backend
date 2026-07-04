'use strict';

const { CircuitBreaker, STATES } = require('../src/utils/circuitBreaker');

function buildBreaker(options = {}) {
  let now = 1000;
  const logger = {
    info: jest.fn(),
  };

  const breaker = new CircuitBreaker('coingecko', {
    failureThreshold: 2,
    successThreshold: 1,
    timeoutMs: 100,
    now: () => now,
    logger,
    ...options,
  });

  return {
    breaker,
    logger,
    advance(ms) {
      now += ms;
    },
  };
}

describe('CircuitBreaker', () => {
  test('opens after repeated failures and skips calls while cooling down', async () => {
    const { breaker, logger } = buildBreaker();

    await expect(breaker.call(async () => null)).resolves.toBeNull();
    await expect(breaker.call(async () => null)).resolves.toBeNull();

    expect(breaker.getState()).toBe(STATES.OPEN);

    const sourceFetch = jest.fn(async () => 0.12);
    await expect(breaker.call(sourceFetch)).resolves.toBeNull();

    expect(sourceFetch).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'Circuit breaker state changed',
      expect.objectContaining({
        source: 'coingecko',
        from: STATES.CLOSED,
        to: STATES.OPEN,
        reason: 'failure-threshold',
      })
    );
  });

  test('moves to half-open after cooldown and closes on a successful probe', async () => {
    const { breaker, advance } = buildBreaker();

    await breaker.call(async () => null);
    await breaker.call(async () => null);

    advance(100);
    expect(breaker.getState()).toBe(STATES.HALF_OPEN);

    await expect(breaker.call(async () => 0.12)).resolves.toBe(0.12);

    expect(breaker.getState()).toBe(STATES.CLOSED);
  });

  test('reopens when the half-open probe fails', async () => {
    const { breaker, advance } = buildBreaker();

    await breaker.call(async () => null);
    await breaker.call(async () => null);

    advance(100);
    await expect(breaker.call(async () => null)).resolves.toBeNull();

    expect(breaker.getState()).toBe(STATES.OPEN);
  });

  test('records thrown source errors as failures and rethrows them', async () => {
    const { breaker } = buildBreaker();
    const error = new Error('rate limited');

    await expect(breaker.call(async () => {
      throw error;
    })).rejects.toThrow('rate limited');

    expect(breaker.getState()).toBe(STATES.CLOSED);
  });
});
