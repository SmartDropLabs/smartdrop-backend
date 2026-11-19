'use strict';

const { AccountLockout } = require('../auth/accountLockout');

describe('AccountLockout (#512)', () => {
  let lockout;

  beforeEach(() => {
    lockout = new AccountLockout({
      maxFailedAttempts: 3,
      lockoutDurationMs: 1000,
      windowMs: 60000,
    });
  });

  it('does not lock after 1 failed attempt', () => {
    const result = lockout.recordFailure('user@test.com');
    expect(result.locked).toBe(false);
    expect(result.failedAttempts).toBe(1);
  });

  it('locks after maxFailedAttempts failed attempts', () => {
    lockout.recordFailure('user@test.com');
    lockout.recordFailure('user@test.com');
    const result = lockout.recordFailure('user@test.com');
    expect(result.locked).toBe(true);
    expect(result.failedAttempts).toBe(3);
    expect(result.lockedUntil).toBeDefined();
  });

  it('isLocked returns true when locked', () => {
    lockout.recordFailure('user@test.com');
    lockout.recordFailure('user@test.com');
    lockout.recordFailure('user@test.com');
    const status = lockout.isLocked('user@test.com');
    expect(status.locked).toBe(true);
    expect(status.remainingMs).toBeGreaterThan(0);
  });

  it('isLocked returns false for unknown identifier', () => {
    const status = lockout.isLocked('unknown@test.com');
    expect(status.locked).toBe(false);
  });

  it('resets failed attempts on successful login', () => {
    lockout.recordFailure('user@test.com');
    lockout.recordFailure('user@test.com');
    lockout.recordSuccess('user@test.com');
    expect(lockout.getFailedAttempts('user@test.com')).toBe(0);
    expect(lockout.isLocked('user@test.com').locked).toBe(false);
  });

  it('unlocks manually', () => {
    lockout.recordFailure('user@test.com');
    lockout.recordFailure('user@test.com');
    lockout.recordFailure('user@test.com');
    lockout.unlock('user@test.com');
    expect(lockout.isLocked('user@test.com').locked).toBe(false);
    expect(lockout.getFailedAttempts('user@test.com')).toBe(0);
  });

  it('tracks separate identifiers independently', () => {
    lockout.recordFailure('user1@test.com');
    lockout.recordFailure('user1@test.com');
    lockout.recordFailure('user1@test.com');
    expect(lockout.isLocked('user1@test.com').locked).toBe(true);
    expect(lockout.isLocked('user2@test.com').locked).toBe(false);
  });
});
