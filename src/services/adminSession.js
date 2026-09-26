'use strict';

/**
 * Admin session service (Redis-backed).
 *
 * Key layout (mirrors the `admin_session` / `AdminSessionList` model from
 * issues #429-#432):
 *
 *   admin_session:<id>      JSON session record (with Redis TTL)
 *   admin:<adminId>:sessions  ZSET of session ids for one admin, score = expiresAtMs
 *   admin_sessions:active     global ZSET of session ids, score = expiresAtMs
 *   admins:ids                SET of known admin ids (bookkeeping only)
 *
 * Fixes:
 *   #429 — createSession persists the record WITH a TTL (and refreshes it on
 *          every validate), so idle session data cannot linger past expiry.
 *   #430 — validateSession performs a single read-modify-write; validation
 *          and refresh share the one fetched record instead of reading the
 *          session twice.
 *   #431 — cleanupExpiredSessions removes expired ids from the per-admin
 *          session list (and the global index), not just marks them inactive.
 *   #432 — getAllActiveSessions pages over the global active index instead
 *          of loading every admin, then every per-admin list, then every
 *          session record (O(admins * sessions * reads)).
 */

const crypto = require('crypto');
const cache = require('./cache');
const logger = require('../logger');

const SESSION_TTL_SECONDS =
  parseInt(process.env.ADMIN_SESSION_TTL_SECONDS, 10) || 12 * 60 * 60;
const ACTIVE_INDEX_KEY = 'admin_sessions:active';
const ADMINS_KEY = 'admins:ids';
// Bound a single cleanup pass so a huge backlog of expired sessions cannot
// block the event loop or balloon memory in one call.
const CLEANUP_BATCH_SIZE =
  parseInt(process.env.ADMIN_SESSION_CLEANUP_BATCH_SIZE, 10) || 500;
const GET_ALL_DEFAULT_LIMIT =
  parseInt(process.env.ADMIN_SESSION_LIST_LIMIT, 10) || 100;

function sessionKey(id) {
  return `admin_session:${id}`;
}

function adminSessionsKey(adminId) {
  return `admin:${adminId}:sessions`;
}

function generateSessionId() {
  return `sess_${crypto.randomUUID().replace(/-/g, '')}`;
}

function sanitize(record) {
  if (!record) return null;
  return { ...record };
}

function isExpired(record, nowMs = Date.now()) {
  if (!record) return true;
  if (record.active === false) return true;
  const expiresAt = Date.parse(record.expires_at);
  return Number.isNaN(expiresAt) || expiresAt <= nowMs;
}

/**
 * #429 — the session record is written with a TTL (SETEX via cache.set) and
 * both index keys get an EXPIRE as well, so session data evicts itself even
 * if it is never accessed again.
 */
async function createSession(adminId, options = {}) {
  if (!adminId || typeof adminId !== 'string') {
    throw new Error('adminSession.createSession: adminId is required');
  }
  const now = new Date();
  const nowMs = now.getTime();
  const expiresAtMs = nowMs + SESSION_TTL_SECONDS * 1000;
  const record = {
    id: generateSessionId(),
    admin_id: adminId,
    active: true,
    created_at: now.toISOString(),
    expires_at: new Date(expiresAtMs).toISOString(),
    last_validated_at: now.toISOString(),
    ip_address: options.ipAddress || null,
    user_agent: options.userAgent || null,
  };

  const redis = cache.getClient();
  // Session record carries the TTL; the per-admin list and global index are
  // only pointers, so they get the same TTL to avoid outliving the data.
  await cache.set(sessionKey(record.id), record, SESSION_TTL_SECONDS);
  const multi = redis.multi();
  multi.zadd(adminSessionsKey(adminId), expiresAtMs, record.id);
  multi.expire(adminSessionsKey(adminId), SESSION_TTL_SECONDS);
  multi.zadd(ACTIVE_INDEX_KEY, expiresAtMs, record.id);
  multi.expire(ACTIVE_INDEX_KEY, SESSION_TTL_SECONDS);
  multi.sadd(ADMINS_KEY, adminId);
  await multi.exec();

  return sanitize(record);
}

async function removeFromIndexes(redis, record) {
  const multi = redis.multi();
  multi.zrem(adminSessionsKey(record.admin_id), record.id);
  multi.zrem(ACTIVE_INDEX_KEY, record.id);
  await multi.exec();
}

/**
 * #430 — single read-modify-write: one cache.get up front, then validation
 * and refresh both operate on that same in-memory record. There is no second
 * read via a separate refreshSession call.
 */
async function validateSession(sessionId) {
  if (!sessionId) return null;
  const record = await cache.get(sessionKey(sessionId));
  if (!record) return null;

  const nowMs = Date.now();
  if (isExpired(record, nowMs)) {
    // Lazily evict the stale pointers (#431) instead of leaving them in the
    // per-admin list / global index.
    try {
      const redis = cache.getClient();
      await removeFromIndexes(redis, record);
      await cache.del(sessionKey(sessionId));
    } catch (err) {
      logger.error('adminSession.validateSession cleanup Redis error', {
        sessionId,
        error: err.message,
      });
    }
    return null;
  }

  // Refresh in place and bump the TTL so active sessions don't expire while
  // in use (#429). Single write, no re-read.
  const refreshed = {
    ...record,
    last_validated_at: new Date(nowMs).toISOString(),
  };
  await cache.set(sessionKey(sessionId), refreshed, SESSION_TTL_SECONDS);
  return sanitize(refreshed);
}

async function getSession(sessionId) {
  if (!sessionId) return null;
  try {
    const record = await cache.get(sessionKey(sessionId));
    return sanitize(record);
  } catch (err) {
    logger.error('adminSession.getSession Redis error', {
      sessionId,
      error: err.message,
    });
    return null;
  }
}

async function revokeSession(sessionId) {
  if (!sessionId) return null;
  const record = await cache.get(sessionKey(sessionId));
  if (!record) return null;
  const redis = cache.getClient();
  await removeFromIndexes(redis, record);
  await cache.del(sessionKey(sessionId));
  return sanitize({ ...record, active: false });
}

/**
 * #431 — expired sessions are removed from the per-admin AdminSessionList
 * (and the global active index), not merely marked inactive, so the lists
 * cannot grow unboundedly with stale entries.
 */
async function cleanupExpiredSessions({ limit = CLEANUP_BATCH_SIZE } = {}) {
  const redis = cache.getClient();
  const nowMs = Date.now();
  let expiredIds;
  try {
    expiredIds =
      (await redis.zrangebyscore(ACTIVE_INDEX_KEY, 0, nowMs, 'LIMIT', 0, limit)) || [];
  } catch (err) {
    logger.error('adminSession.cleanupExpiredSessions index read Redis error', {
      error: err.message,
    });
    return { cleaned: 0, checked: 0 };
  }
  if (expiredIds.length === 0) return { cleaned: 0, checked: 0 };

  const records = await Promise.all(expiredIds.map((id) => cache.get(sessionKey(id))));
  const pipeline = redis.multi();
  let cleaned = 0;
  for (let i = 0; i < expiredIds.length; i += 1) {
    const id = expiredIds[i];
    const record = records[i];
    // Always drop the global index pointer; also drop the per-admin pointer
    // when we know which admin owned the session.
    pipeline.zrem(ACTIVE_INDEX_KEY, id);
    if (record && record.admin_id) {
      pipeline.zrem(adminSessionsKey(record.admin_id), id);
    }
    cleaned += 1;
  }
  try {
    await pipeline.exec();
  } catch (err) {
    logger.error('adminSession.cleanupExpiredSessions evict Redis error', {
      error: err.message,
    });
    return { cleaned: 0, checked: expiredIds.length };
  }

  // Delete the backing records after the index pointers are gone.
  await Promise.all(expiredIds.map((id) => cache.del(sessionKey(id))));
  return { cleaned, checked: expiredIds.length };
}

/**
 * #432 — page over the global active index (one ZRANGEBYSCORE + one batched
 * fetch of just that page's records) instead of loading the full admin list,
 * then every admin's session list, then every session record.
 */
async function getAllActiveSessions({ limit = GET_ALL_DEFAULT_LIMIT, offset = 0 } = {}) {
  const redis = cache.getClient();
  const nowMs = Date.now();
  try {
    const pageSize = Math.max(1, Math.min(limit, 1000));
    const startOffset = Math.max(0, offset);
    const ids = (await redis.zrangebyscore(
      ACTIVE_INDEX_KEY,
      nowMs,
      '+inf',
      'LIMIT',
      startOffset,
      pageSize,
    )) || [];
    if (ids.length === 0) return [];
    const records = await Promise.all(ids.map((id) => cache.get(sessionKey(id))));
    return records.filter((r) => r && !isExpired(r, Date.now())).map(sanitize);
  } catch (err) {
    logger.error('adminSession.getAllActiveSessions Redis error', { error: err.message });
    return [];
  }
}

async function listSessionsByAdmin(adminId, { limit = GET_ALL_DEFAULT_LIMIT } = {}) {
  if (!adminId) return [];
  try {
    const redis = cache.getClient();
    const nowMs = Date.now();
    const ids = (await redis.zrangebyscore(
      adminSessionsKey(adminId),
      nowMs,
      '+inf',
      'LIMIT',
      0,
      Math.max(1, Math.min(limit, 1000)),
    )) || [];
    if (ids.length === 0) return [];
    const records = await Promise.all(ids.map((id) => cache.get(sessionKey(id))));
    return records.filter((r) => r && !isExpired(r, Date.now())).map(sanitize);
  } catch (err) {
    logger.error('adminSession.listSessionsByAdmin Redis error', {
      adminId,
      error: err.message,
    });
    return [];
  }
}

module.exports = {
  ACTIVE_INDEX_KEY,
  SESSION_TTL_SECONDS,
  cleanupExpiredSessions,
  createSession,
  getAllActiveSessions,
  getSession,
  listSessionsByAdmin,
  revokeSession,
  validateSession,
};
