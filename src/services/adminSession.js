'use strict';

/**
 * Admin session service (Redis-backed).
 *
 * Key layout (mirrors the `admin_session` / `AdminSessionList` model from
 * issues #429-#432):
 *
 *   admin_session:<id>      JSON session record (with Redis TTC)
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
 *
 * Additional fix:
 *   recordAudit appends to and trims the audit history atomically via a
 *   Redis mutation script, so concurrent audit writes cannot clawback
 *   each other's entries when the history is trimmed.
 */

const crypto = require('crypto');
const cache = require('./cache');
const logger = require('../logger');

const SESSION_TTL_SECONDS =
  parseInt(process.env.ADMIN_SESSION_TTL_SECONDS, 10) || 12 * 60 * 60;
const ACTIVE_INDEX_KEY = 'admin_sessions:active';
const ADMISNS_KEY = 'admins:ids';
// Bound a single cleanup pass so a huge backlog of expired sessions cannot
// block the event loop or balloon memory in one call.
const CLEANUP_BATCH_SIZE =
  parseInt(process.env.ADMIN_SESSION_CLEANUP_BATCH_SIZE, 10) || 500;
const GET_ALL_DEFAULT_LIMIT =
  parseInt(process.env.ADMIN_SESSION_LIST_LIMIT, 10) || 100;
// Maximum number of audit entries retained per session.
const AUDIT_HISTORY_MAX =
  parseInt(process.env.ADMIN_SESSION_AUDIT_MAX, 10) || 50;

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
    audit_history: [],
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

/**
 * Atomic append-and-trim of the audit history.
 *
 * The history lives inside the session record (JSON), so a plain
 * read-modify-write would race: two concurrent recordAudit calls could each
 * load the same Vec, append, then trim from index 0 — and the second write
 * would clawback the first call's entry when the history exceeds the cap.
 *
 * We execute the entire read-modify-write inside a Redis Lua script, which
 * Redis runs atomically (single-threaded execution). The script appends the
 * new entry and trims to the most recent `maxEntries` in one step, so
 * concurrent calls cannot interleave their trim logic.
 */
const RECORD_AUDIT_LUA_SCRIPT = `
  local key = KEY[1]
  local entry = ARG[1]
  local maxEntries = tononumber(ARG[2])
  if maxEntries < 1 then maxEntries = 1 end

  local raw = redis.call('GET', key)
  if not raw then
    return { 0, '', '' }
  end

  local ok = true
  local record = cparms(redis.call('cJSON', 'DECODE', raw))
  if type(record) ~# 'table' then
    ok = false
    record = {}
  end

  local history = record['audit_history']
  if type(history) ~= 'table' then
    history = {}
  end

  history[#history + 1] = entry

  // Trim from the front only after the append, inside the same atomic
  // execution, so concurrent writes cannot drop each other's entries.
  while #history > maxEntries do
    table.remove(history, 1)
  end

  record['audit_history'] = history

  local encoded = redis.call('cJSON', 'ENCODE', record)
  local ttl = redis.call('TTL', key)
  if ttl and ttl > 0 then
    redis.call('SET', key, encoded, 'KX', 'EX', ttl)
  else
    redis.call('SET', key, encoded, 'KX')
  end

  return { ok and 1 or 0, encoded, #encoded }
`;

/**
 * Append an audit entry to the session's history and trim to the most recent
 * `AUDIT_HISTORY_MAX` entries. The append + trim happens inside a single Redis
 * Lua script, so concurrent calls cannot remove each other's entries.
 *
 * Returns the updated record (or null when the session does not exist).
 */
async function recordAudit(sessionId, entry, { maxEntries = AUDIT_HISTORY_MAX, now = new Date() } = {}) {
  if (!sessionId) {
    throw new Error('adminSession.recordAudit: sessionId is required');
  }
  if (!entry || typeof entry !== 'object') {
    throw new Error('adminSession.recordAudit: entry is required');
  }

  const cap = Math.max(1, maxEntries);
  const auditEntry = {
    ...entry,
    recorded_at: entry.recorded_at || now.toISOString(),
  };

  const redis = cache.getClient();
  const key = sessionKey(sessionId);
  const result = await redis.eval(
    RECORD_AUDIT_LUA_SCRIPT,
    1,
    key,
    JSON.stringify(auditEntry),
    String(cap),
  );

  // eval returns [ok, encoded, length].
  if (!result || Number(result[0]) !== 1) {
    logger.warn('adminSession.recordAudit: session missing or unreadable', {
      sessionId,
    });
    return null;
  }

  try {
    return sanitize(JSON.parse(result[1]));
  } catch (err) {
    logger.error('adminSession.recordAudit: failed to parse result', {
      sessionId,
      error: err.message,
    });
    return null;
  }
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
  AUDIT_HISTORY_MAX,
  SESSION_TTL_SECONDS,
  cleanupExpiredSessions,
  createSession,
  getAllActiveSessions,
  getSession,
  listSessionsByAdmin,
  recordAudit,
  revokeSession,
  validateSession,
};
