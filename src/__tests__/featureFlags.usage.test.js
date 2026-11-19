'use strict';

jest.mock('../services/cache', () => ({
  del: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const featureFlags = require('../services/featureFlags');
const logger = require('../logger');

const {
  evaluateFlag,
  trackUsage,
  getUsageStats,
  resetUsageStats,
  setFlag,
  isEnabled,
} = featureFlags;

beforeEach(() => {
  resetUsageStats();
  jest.clearAllMocks();
  // Flags persist in module state; clear the ones these tests use.
  featureFlags.removeFlag('usage-on');
  featureFlags.removeFlag('usage-off');
  featureFlags.removeFlag('usage-rollout');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('evaluateFlag', () => {
  it('returns the same result as isEnabled for the same context', () => {
    setFlag('usage-rollout', { enabled: true, percentage: 50 });
    for (let i = 0; i < 20; i++) {
      const userId = `user-${i}`;
      expect(evaluateFlag('usage-rollout', userId)).toBe(
        isEnabled('usage-rollout', { userId })
      );
    }
  });

  it('returns false for unknown flags and still records the evaluation', () => {
    expect(evaluateFlag('does-not-exist', 'u1')).toBe(false);
    expect(getUsageStats('does-not-exist')).toMatchObject({
      evaluations: 1,
      enabled: 0,
      disabled: 1,
    });
  });

  it('records enabled and disabled outcomes separately', () => {
    setFlag('usage-on', { enabled: true });
    setFlag('usage-off', { enabled: false });

    expect(evaluateFlag('usage-on', 'u1')).toBe(true);
    expect(evaluateFlag('usage-on', 'u2')).toBe(true);
    expect(evaluateFlag('usage-off', 'u1')).toBe(false);

    expect(getUsageStats('usage-on')).toMatchObject({ evaluations: 2, enabled: 2, disabled: 0 });
    expect(getUsageStats('usage-off')).toMatchObject({ evaluations: 1, enabled: 0, disabled: 1 });
  });

  it('works without a userId', () => {
    setFlag('usage-on', { enabled: true });
    expect(evaluateFlag('usage-on')).toBe(true);
    expect(getUsageStats('usage-on').evaluations).toBe(1);
  });

  it('still returns the flag result when tracking throws', () => {
    setFlag('usage-on', { enabled: true });
    // Date.now is used by trackUsage; make it throw inside the tracking path only.
    jest.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('clock failure');
    });

    expect(evaluateFlag('usage-on', 'u1')).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('usage-on'),
      expect.objectContaining({ error: 'clock failure' })
    );
  });

  it('does not throw when the logger itself fails', () => {
    setFlag('usage-off', { enabled: false });
    jest.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('clock failure');
    });
    logger.warn.mockImplementation(() => {
      throw new Error('logger down');
    });

    expect(() => evaluateFlag('usage-off', 'u1')).not.toThrow();
    expect(evaluateFlag('usage-off', 'u1')).toBe(false);
  });
});

describe('trackUsage', () => {
  it('does not store user IDs', () => {
    trackUsage('usage-on', 'secret-user-id', true);
    expect(JSON.stringify(getUsageStats())).not.toContain('secret-user-id');
  });

  it('never throws', () => {
    expect(() => trackUsage(undefined, undefined, true)).not.toThrow();
  });
});

describe('getUsageStats / resetUsageStats', () => {
  it('returns null for a flag that was never evaluated', () => {
    expect(getUsageStats('never-seen')).toBeNull();
  });

  it('returns all flags when no name is given', () => {
    evaluateFlag('usage-on', 'u1');
    evaluateFlag('usage-off', 'u1');
    const all = getUsageStats();
    expect(Object.keys(all).sort()).toEqual(['usage-off', 'usage-on']);
  });

  it('returns copies, so callers cannot mutate internal counters', () => {
    evaluateFlag('usage-on', 'u1');
    const snapshot = getUsageStats('usage-on');
    snapshot.evaluations = 999;
    expect(getUsageStats('usage-on').evaluations).toBe(1);
  });

  it('resetUsageStats clears all counters', () => {
    evaluateFlag('usage-on', 'u1');
    resetUsageStats();
    expect(getUsageStats()).toEqual({});
  });
});

describe('existing API', () => {
  it('still exports the original functions', () => {
    for (const fn of ['initFromEnv', 'setFlag', 'updateFlag', 'removeFlag', 'isEnabled', 'getAllFlags']) {
      expect(typeof featureFlags[fn]).toBe('function');
    }
  });

  it('isEnabled does not record usage', () => {
    setFlag('usage-on', { enabled: true });
    isEnabled('usage-on', { userId: 'u1' });
    expect(getUsageStats('usage-on')).toBeNull();
  });
});
