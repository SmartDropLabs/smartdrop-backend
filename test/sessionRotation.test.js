'use strict';

/**
 * #616 — sessions are rotated / revoked when a user's privileges change, so
 * a session id issued under the old privileges cannot keep being used.
 */

const mockStore = new Map();
const mockSets = new Map();

jest.mock('../src/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('../src/services/cache', () => {
  const client = {
    zadd: jest.fn(async () => 1),
    zrem: jest.fn(async () => 1),
    sadd: jest.fn(async (key, member) => {
      if (!mockSets.has(key)) mockSets.set(key, new Set());
      mockSets.get(key).add(member);
    }),
    srem: jest.fn(async (key, member) => {
      mockSets.get(key)?.delete(member);
    }),
    smembers: jest.fn(async (key) => [...(mockSets.get(key) || [])]),
    del: jest.fn(async (key) => {
      mockSets.delete(key);
    }),
  };
  return {
    getClient: () => client,
    get: jest.fn(async (key) => {
      const v = mockStore.get(key);
      return v !== undefined ? JSON.parse(JSON.stringify(v)) : null;
    }),
    set: jest.fn(async (key, value) => {
      mockStore.set(key, JSON.parse(JSON.stringify(value)));
    }),
    del: jest.fn(async (key) => {
      mockStore.delete(key);
    }),
  };
});

const {
  createSession,
  validateSession,
  rotateSession,
  handlePrivilegeChange,
} = require('../src/auth/session');

beforeEach(() => {
  mockStore.clear();
  mockSets.clear();
});

describe('rotateSession (#616)', () => {
  it('issues a new session id for the same user and revokes the old one', async () => {
    const old = await createSession('user-1', { ipAddress: '10.0.0.1', userAgent: 'ua' });

    const fresh = await rotateSession(old.id);

    expect(fresh).not.toBeNull();
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.user_id).toBe('user-1');
    expect(fresh.ip_address).toBe('10.0.0.1');
    expect(fresh.user_agent).toBe('ua');
    expect(await validateSession(old.id, { touch: false })).toBeNull();
    expect(await validateSession(fresh.id, { touch: false })).not.toBeNull();
  });

  it('returns null when there is no live session to rotate', async () => {
    expect(await rotateSession('sess_missing')).toBeNull();
  });
});

describe('handlePrivilegeChange (#616)', () => {
  it('revokes every session the user holds', async () => {
    const a = await createSession('user-2');
    const b = await createSession('user-2');
    const other = await createSession('user-3');

    const { revoked, session } = await handlePrivilegeChange('user-2');

    expect(revoked).toBe(2);
    expect(session).toBeNull();
    expect(await validateSession(a.id, { touch: false })).toBeNull();
    expect(await validateSession(b.id, { touch: false })).toBeNull();
    expect(await validateSession(other.id, { touch: false })).not.toBeNull();
  });

  it('replaces the calling session with a rotated one', async () => {
    const current = await createSession('user-4');
    const elsewhere = await createSession('user-4');

    const { session } = await handlePrivilegeChange('user-4', { currentSessionId: current.id });

    expect(session).not.toBeNull();
    expect(session.id).not.toBe(current.id);
    expect(session.user_id).toBe('user-4');
    expect(await validateSession(current.id, { touch: false })).toBeNull();
    expect(await validateSession(elsewhere.id, { touch: false })).toBeNull();
    expect(await validateSession(session.id, { touch: false })).not.toBeNull();
  });

  it('does not hand a session to a caller whose session belongs to someone else', async () => {
    const admin = await createSession('admin-1');
    await createSession('user-5');

    const { session } = await handlePrivilegeChange('user-5', { currentSessionId: admin.id });

    expect(session).toBeNull();
    // The admin's own session is unaffected by changing someone else's role.
    expect(await validateSession(admin.id, { touch: false })).not.toBeNull();
  });

  it('requires a user id', async () => {
    await expect(handlePrivilegeChange()).rejects.toThrow(/userId is required/);
  });
});
