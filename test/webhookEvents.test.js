'use strict';

const events = require('../src/services/webhookEvents');

describe('webhook event registry', () => {
  test('pool.assets_locked is a known event', () => {
    expect(events.isKnownEvent('pool.assets_locked')).toBe(true);
  });

  test('unknown event types are rejected', () => {
    expect(events.isKnownEvent('something.random')).toBe(false);
  });

  test('isValidSubscription accepts a non-empty array of known events', () => {
    expect(events.isValidSubscription(['pool.assets_locked'])).toBe(true);
    expect(events.isValidSubscription(['pool.assets_locked', 'pool.closed'])).toBe(true);
  });

  test('isValidSubscription accepts wildcard', () => {
    expect(events.isValidSubscription(['*'])).toBe(true);
  });

  test('isValidSubscription rejects empty arrays and bad inputs', () => {
    expect(events.isValidSubscription([])).toBe(false);
    expect(events.isValidSubscription(null)).toBe(false);
    expect(events.isValidSubscription(['nope'])).toBe(false);
  });

  test('matchesSubscription exact match', () => {
    expect(events.matchesSubscription(['pool.assets_locked'], 'pool.assets_locked')).toBe(true);
    expect(events.matchesSubscription(['pool.closed'], 'pool.assets_locked')).toBe(false);
  });

  test('matchesSubscription wildcard subscribes to all', () => {
    expect(events.matchesSubscription(['*'], 'pool.assets_locked')).toBe(true);
    expect(events.matchesSubscription(['*'], 'price.alert')).toBe(true);
  });
});
