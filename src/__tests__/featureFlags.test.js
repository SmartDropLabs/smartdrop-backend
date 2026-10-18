'use strict';

const { FeatureFlagService } = require('../services/featureFlags');

describe('FeatureFlagService (#517)', () => {
  it('returns false for unknown flags and respects boolean flag definitions', () => {
    const service = new FeatureFlagService({
      new_claim_flow: true,
      experimental_indexer: false,
    });

    expect(service.isEnabled('unknown_flag')).toBe(false);
    expect(service.isEnabled('new_claim_flow')).toBe(true);
    expect(service.isEnabled('experimental_indexer')).toBe(false);
  });

  it('supports allowlist and blocklist targeting per userId', () => {
    const service = new FeatureFlagService({
      beta_dashboard: {
        enabled: true,
        rolloutPercentage: 0,
        allowlist: ['user_alpha'],
        blocklist: ['user_blocked'],
      },
    });

    expect(service.isEnabled('beta_dashboard', { userId: 'user_alpha' })).toBe(true);
    expect(service.isEnabled('beta_dashboard', { userId: 'user_regular' })).toBe(false);

    service.defineFlag('full_rollout', {
      enabled: true,
      rolloutPercentage: 100,
      blocklist: ['user_blocked'],
    });
    expect(service.isEnabled('full_rollout', { userId: 'user_blocked' })).toBe(false);
    expect(service.isEnabled('full_rollout', { userId: 'user_regular' })).toBe(true);
  });

  it('deterministically buckets users for percentage rollouts', () => {
    const service = new FeatureFlagService({
      gradual_feature: {
        enabled: true,
        rolloutPercentage: 50,
      },
    });

    let enabledCount = 0;
    for (let i = 0; i < 200; i += 1) {
      const userId = `user_${i}`;
      const firstEval = service.isEnabled('gradual_feature', { userId });
      const secondEval = service.isEnabled('gradual_feature', { userId });
      expect(firstEval).toBe(secondEval);
      if (firstEval) enabledCount += 1;
    }

    expect(enabledCount).toBeGreaterThan(60);
    expect(enabledCount).toBeLessThan(140);
  });

  it('honors environment variable overrides', () => {
    const service = new FeatureFlagService(
      { kill_switch_target: true },
      { env: { FEATURE_FLAG_KILL_SWITCH_TARGET: 'false' } }
    );

    expect(service.isEnabled('kill_switch_target')).toBe(false);
  });

  it('gates Express routes via requireFlag middleware', () => {
    const service = new FeatureFlagService({ active_endpoint: false });
    const middleware = service.requireFlag('active_endpoint');

    let statusSet = null;
    let bodySent = null;
    const res = {
      status(code) {
        statusSet = code;
        return this;
      },
      json(payload) {
        bodySent = payload;
        return this;
      },
    };

    let nextCalled = false;
    middleware({ headers: {} }, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false);
    expect(statusSet).toBe(404);
    expect(bodySent).toEqual({
      error: "Feature 'active_endpoint' is not enabled",
      flag: 'active_endpoint',
    });
  });
});
