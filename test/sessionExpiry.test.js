'use strict';

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

const mockStore = new Map();
const mockSortedSets = new Map();

jest.mock('../src/services/cache', () => {
  return {
    getClient: () => ({
      zadd: jest.fn(async (key, score, member) => {
        if (!mockSortedSets.has(key)) mockSortedSets.set(key, new Map());
        mockSortedSets.get(key).set(member, score);
      }),
      zrem: jest.fn(async (key, member) => {
        mockSortedSets.get(key)?.delete(member);
      }),
      zrangebyscore: jest.fn(async (key, min, max) => {
        const sortedSet = mockSortedSets.get(key);
        if (!sortedSet) return [];
        const minVal = min === '-inf' ? -Infinity : Number(min);
        const maxVal = max === '+inf' ? Infinity : Number(max);
        const results = [];
        for (const [member, score] of sortedSet.entries()) {
          if (score >= minVal && score <= maxVal) {
            results.push(member);
          }
        }
        return results;
      }),
      multi: jest.fn(() => ({
        zrem: jest.fn(),
        exec: jest.fn(async () => []),
      })),
    }),
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

const cache = require('../src/services/cache');
const {
  createSession,
  validateSession,
  invalidateSession,
  cleanupExpiredSessions,
  sessionAuth,
  getSessionCookieOptions,
  isSessionExpired,
  ABSOLUTE_LIFETIME_SECONDS,
  IDLE_TIMEOUT_SECONDS,
  ACTIVITY_THROTTLE_SECONDS,
} = require('../src/auth/session');
const { verifyJwt } = require('../src/middleware/jwtAuth');
const { errorHandler } = require('../src/middleware/errorHandler');

describe('Issue #469: Session Expiry Enforcement', () => {
  beforeEach(() => {
    mockStore.clear();
    mockSortedSets.clear();
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('1. Dual-Window Session Lifetimes', () => {
    it('accepts a session that is within both the absolute and idle windows', async () => {
      const now = new Date('2026-10-18T10:00:00.000Z');
      jest.setSystemTime(now);

      const session = await createSession('user-123');
      const validated = await validateSession(session.id);

      expect(validated).not.toBeNull();
      expect(validated.id).toBe(session.id);
      expect(validated.user_id).toBe('user-123');
    });

    it('rejects a session past the absolute lifetime even if it was active a moment ago', async () => {
      const startTime = new Date('2026-10-18T10:00:00.000Z');
      jest.setSystemTime(startTime);

      const session = await createSession('user-123');

      // Fast forward past absolute lifetime (default 24h = 86400s) + leeway
      const pastAbsolute = new Date(startTime.getTime() + (ABSOLUTE_LIFETIME_SECONDS + 120) * 1000);
      jest.setSystemTime(pastAbsolute);

      // Even if last_activity_at was 1 second ago:
      const activeRecord = {
        ...session,
        last_activity_at: new Date(pastAbsolute.getTime() - 1000).toISOString(),
      };
      await cache.set(`session:${session.id}`, activeRecord);

      const validated = await validateSession(session.id);
      expect(validated).toBeNull();
    });

    it('rejects a session past the idle timeout window', async () => {
      const startTime = new Date('2026-10-18T10:00:00.000Z');
      jest.setSystemTime(startTime);

      const session = await createSession('user-123');

      // Advance past idle timeout (default 30m = 1800s) + clock skew leeway (60s)
      const pastIdle = new Date(startTime.getTime() + (IDLE_TIMEOUT_SECONDS + 120) * 1000);
      jest.setSystemTime(pastIdle);

      const validated = await validateSession(session.id);
      expect(validated).toBeNull();
    });

    it('extends the idle expiry on activity within the idle window, but never exceeds the absolute lifetime', async () => {
      const startTime = new Date('2026-10-18T10:00:00.000Z');
      jest.setSystemTime(startTime);

      const session = await createSession('user-123');
      const absoluteExpiryMs = Date.parse(session.absolute_expires_at);

      // Advance 10 minutes (within idle window and past throttle window)
      const t1 = new Date(startTime.getTime() + 10 * 60 * 1000);
      jest.setSystemTime(t1);

      const touched = await validateSession(session.id);
      expect(touched).not.toBeNull();
      const idleExpiry1 = Date.parse(touched.idle_expires_at);
      expect(idleExpiry1).toBe(t1.getTime() + IDLE_TIMEOUT_SECONDS * 1000);

      // Advance to near absolute expiration (absolute - 5 minutes)
      const nearEnd = new Date(absoluteExpiryMs - 5 * 60 * 1000);
      jest.setSystemTime(nearEnd);

      const endTouched = await validateSession(session.id);
      expect(endTouched).not.toBeNull();
      // Idle expiry must be capped at absolute lifetime, never extend past it
      const finalIdleExpiry = Date.parse(endTouched.idle_expires_at);
      expect(finalIdleExpiry).toBeLessThanOrEqual(absoluteExpiryMs);
    });
  });

  describe('2. JWT Missing Expiry Rejection', () => {
    const secret = 'super-secret-key-32-bytes-long!';

    function createJwt(payload, alg = 'HS256') {
      const header = { alg, typ: 'JWT' };
      const hB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
      const pB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const data = `${hB64}.${pB64}`;
      const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
      return `${data}.${sig}`;
    }

    it('rejects a JWT token without an exp claim', () => {
      const tokenWithoutExp = createJwt({ sub: 'user-1', name: 'Alice' });
      expect(() => {
        verifyJwt(tokenWithoutExp, secret);
      }).toThrow('Invalid token');
    });

    it('rejects an expired JWT token', () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const expiredToken = createJwt({ sub: 'user-1', exp: nowSeconds - 300 }); // expired 5 mins ago
      expect(() => {
        verifyJwt(expiredToken, secret);
      }).toThrow('Invalid token');
    });

    it('accepts a valid JWT with future exp', () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const validToken = createJwt({ sub: 'user-1', exp: nowSeconds + 3600 });
      const decoded = verifyJwt(validToken, secret);
      expect(decoded.sub).toBe('user-1');
    });
  });

  describe('3. Activity Write Throttling and Failure Safety', () => {
    it('throttles last-activity writes so store is not updated on every request', async () => {
      const startTime = new Date('2026-10-18T10:00:00.000Z');
      jest.setSystemTime(startTime);

      const session = await createSession('user-123');
      cache.set.mockClear();

      // Rapid requests within throttle interval (e.g. 10s < ACTIVITY_THROTTLE_SECONDS 60s)
      jest.setSystemTime(new Date(startTime.getTime() + 10 * 1000));
      await validateSession(session.id);
      expect(cache.set).not.toHaveBeenCalled();

      jest.setSystemTime(new Date(startTime.getTime() + 30 * 1000));
      await validateSession(session.id);
      expect(cache.set).not.toHaveBeenCalled();

      // Request after throttle interval (e.g. 70s > 60s)
      jest.setSystemTime(new Date(startTime.getTime() + 70 * 1000));
      await validateSession(session.id);
      expect(cache.set).toHaveBeenCalledTimes(1);
    });

    it('does not extend the session if the request fails with an error', async () => {
      const startTime = new Date('2026-10-18T10:00:00.000Z');
      jest.setSystemTime(startTime);

      const session = await createSession('user-123');
      cache.set.mockClear();

      const app = express();
      app.use(sessionAuth({ required: true }));
      app.get('/failing-endpoint', (req, res, next) => {
        const err = new Error('Database error');
        err.statusCode = 500;
        next(err);
      });
      app.use(errorHandler);

      // Advance time past throttle threshold
      jest.setSystemTime(new Date(startTime.getTime() + 120 * 1000));

      const res = await request(app)
        .get('/failing-endpoint')
        .set('Cookie', `session_id=${session.id}`);

      expect(res.status).toBe(500);
      // Session store write must NOT occur on a failed request
      expect(cache.set).not.toHaveBeenCalled();
    });
  });

  describe('4. Invalidation and Cleanup', () => {
    it('invalidates the session on logout', async () => {
      const session = await createSession('user-123');
      const ok = await invalidateSession(session.id);
      expect(ok).toBe(true);

      const retrieved = await validateSession(session.id);
      expect(retrieved).toBeNull();
    });

    it('cleans up expired entries from the active index and store', async () => {
      const now = new Date('2026-10-18T10:00:00.000Z');
      jest.setSystemTime(now);

      const session = await createSession('user-123');

      // Fast forward past expiry
      const future = new Date(now.getTime() + 100000 * 1000);
      jest.setSystemTime(future);

      const result = await cleanupExpiredSessions({ nowMs: future.getTime() });
      expect(result.checked).toBeGreaterThanOrEqual(1);
    });
  });

  describe('5. Legacy Session Compatibility', () => {
    it('gracefully handles legacy sessions without expiry fields by deriving from created_at', async () => {
      const now = new Date('2026-10-18T10:00:00.000Z');
      jest.setSystemTime(now);

      const legacySession = {
        id: 'sess_legacy123',
        user_id: 'legacy-user',
        active: true,
        created_at: new Date(now.getTime() - 10 * 60 * 1000).toISOString(), // 10 minutes ago
        // Notice: absolute_expires_at and idle_expires_at are absent!
      };
      await cache.set(`session:${legacySession.id}`, legacySession);

      const validated = await validateSession(legacySession.id);
      expect(validated).not.toBeNull();
      expect(validated.absolute_expires_at).toBeDefined();
      expect(validated.idle_expires_at).toBeDefined();
    });

    it('rejects an old legacy session whose created_at is past the absolute lifetime', async () => {
      const now = new Date('2026-10-18T10:00:00.000Z');
      jest.setSystemTime(now);

      const oldLegacySession = {
        id: 'sess_oldlegacy123',
        user_id: 'legacy-user',
        active: true,
        created_at: new Date(now.getTime() - (ABSOLUTE_LIFETIME_SECONDS + 3600) * 1000).toISOString(),
      };
      await cache.set(`session:${oldLegacySession.id}`, oldLegacySession);

      const validated = await validateSession(oldLegacySession.id);
      expect(validated).toBeNull();
    });
  });

  describe('6. Cookie Lifetime Alignment (#496)', () => {
    it('sets cookie maxAge strictly equal to remaining server-side session lifetime', () => {
      const now = new Date('2026-10-18T10:00:00.000Z');
      jest.setSystemTime(now);

      const session = {
        created_at: now.toISOString(),
        last_activity_at: now.toISOString(),
        absolute_expires_at: new Date(now.getTime() + 86400 * 1000).toISOString(),
        idle_expires_at: new Date(now.getTime() + 1800 * 1000).toISOString(),
      };

      const options = getSessionCookieOptions(session, { isSecure: true });
      expect(options.httpOnly).toBe(true);
      expect(options.secure).toBe(true);
      expect(options.sameSite).toBe('lax');
      expect(options.maxAge).toBe(1800 * 1000);
    });
  });
});
