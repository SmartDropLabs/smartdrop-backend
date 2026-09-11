'use strict';

const runtimeConfig = require('../src/services/runtimeConfig');
const baseConfig = require('../src/config');

describe('RuntimeConfigService', () => {
  beforeEach(() => {
    runtimeConfig.reset();
    runtimeConfig.removeAllListeners();
  });

  afterEach(() => {
    runtimeConfig.stopWatcher();
    runtimeConfig.reset();
    runtimeConfig.removeAllListeners();
  });

  test('initializes with default base config values', () => {
    expect(runtimeConfig.get('rateLimitMax')).toBe(baseConfig.rateLimit.max);
    expect(runtimeConfig.get('rateLimitWindowMs')).toBe(baseConfig.rateLimit.windowMs);
    expect(runtimeConfig.get('priceAnomalyThresholdPct')).toBe(baseConfig.price.anomalyThresholdPercent);
    expect(runtimeConfig.get('priceAnomalyAction')).toBe(baseConfig.price.anomalyAction);
    expect(runtimeConfig.get('featureFlags')).toEqual({});
  });

  test('validates updates and applies hot-reload changes', () => {
    const changeListener = jest.fn();
    runtimeConfig.on('change', changeListener);

    const result = runtimeConfig.applyChanges({
      rateLimitMax: 500,
      priceAnomalyAction: 'reject',
      featureFlags: { enableNewUI: true },
    });

    expect(result.updated).toBe(true);
    expect(runtimeConfig.get('rateLimitMax')).toBe(500);
    expect(runtimeConfig.get('priceAnomalyAction')).toBe('reject');
    expect(runtimeConfig.get('featureFlags')).toEqual({ enableNewUI: true });

    expect(changeListener).toHaveBeenCalledTimes(1);
    expect(changeListener).toHaveBeenCalledWith(
      expect.objectContaining({
        rateLimitMax: 500,
        priceAnomalyAction: 'reject',
        featureFlags: { enableNewUI: true },
      }),
      expect.objectContaining({
        rateLimitMax: expect.objectContaining({ oldValue: baseConfig.rateLimit.max, newValue: 500 }),
        priceAnomalyAction: expect.objectContaining({ oldValue: baseConfig.price.anomalyAction, newValue: 'reject' }),
      })
    );
  });

  test('emits specific key change events', () => {
    const keyListener = jest.fn();
    runtimeConfig.on('change:slowRequestThresholdMs', keyListener);

    runtimeConfig.applyChanges({
      slowRequestThresholdMs: 2500,
    });

    expect(keyListener).toHaveBeenCalledWith(2500, baseConfig.slowRequestThresholdMs);
  });

  test('rejects invalid config values with descriptive errors', () => {
    expect(() => {
      runtimeConfig.applyChanges({ rateLimitMax: -10 });
    }).toThrow('rateLimitMax must be a positive integer');

    expect(() => {
      runtimeConfig.applyChanges({ rateLimitMax: 'invalid' });
    }).toThrow('rateLimitMax must be a positive integer');

    expect(() => {
      runtimeConfig.applyChanges({ priceAnomalyAction: 'drop' });
    }).toThrow('priceAnomalyAction must be either "warn" or "reject"');

    expect(() => {
      runtimeConfig.applyChanges({ featureFlags: 'true' });
    }).toThrow('featureFlags must be an object');
  });

  test('rejects cold-reload critical configuration keys', () => {
    expect(() => {
      runtimeConfig.applyChanges({ DATABASE_URL: 'postgres://newdb:5432/db' });
    }).toThrow('Unsupported or cold-reload config key: DATABASE_URL');

    expect(() => {
      runtimeConfig.applyChanges({ REDIS_URL: 'redis://newredis:6379' });
    }).toThrow('Unsupported or cold-reload config key: REDIS_URL');
  });

  test('does not emit events when values remain identical', () => {
    const changeListener = jest.fn();
    runtimeConfig.on('change', changeListener);

    // Apply first change
    runtimeConfig.applyChanges({ rateLimitMax: 200 });
    expect(changeListener).toHaveBeenCalledTimes(1);

    // Apply identical value
    const result = runtimeConfig.applyChanges({ rateLimitMax: 200 });
    expect(result.updated).toBe(false);
    expect(changeListener).toHaveBeenCalledTimes(1);
  });
});
