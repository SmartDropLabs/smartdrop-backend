'use strict';

/**
 * Webhook repository.
 *
 * Schema mirrors the future PostgreSQL `webhooks` table so that swapping the
 * Redis backing for a real DB only requires re-implementing this module:
 *
 *   webhooks (
 *     id           text primary key,
 *     url          text not null,
 *     events       text[] not null,
 *     secret       text not null,
 *     active       boolean not null default true,
 *     description  text,
 *     created_at   timestamptz not null default now(),
 *     updated_at   timestamptz not null default now()
 *   )
 */

const crypto = require('crypto');
const cache = require('../services/cache');
const logger = require('../logger');
const { encryptSecret, decryptSecret, isEncrypted } = require('../services/webhookEncryption');

const IDS_KEY = 'webhooks:ids';

function key(id) {
  return `webhook:${id}`;
}

function generateId() {
  return `wh_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/**
 * Decrypts `record.secret` for callers (webhookDispatcher needs the
 * plaintext to sign deliveries; routes/webhooks.js needs it for
 * secret_preview). Records written before encryption was introduced store
 * the secret in plaintext (`isEncrypted` returns false for those) and are
 * passed through unchanged, so existing webhooks keep working — they're
 * transparently encrypted the next time they're written via `update()`.
 */
function decryptRecordSecret(secret) {
  if (!isEncrypted(secret)) return secret;
  try {
    return decryptSecret(secret);
  } catch (err) {
    logger.error('webhookRepository: failed to decrypt webhook secret', { error: err.message });
    return null;
  }
}

function normalize(record) {
  if (!record) return null;
  return {
    id: record.id,
    url: record.url,
    events: Array.isArray(record.events) ? [...record.events] : [],
    secret: decryptRecordSecret(record.secret),
    active: record.active !== false,
    description: record.description || null,
    filters: record.filters ? { ...record.filters } : null,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

async function create({ url, events, secret, description, filters, owner_ip }) {
  const id = generateId();
  const now = new Date().toISOString();
  const record = {
    id,
    url,
    events,
    secret: encryptSecret(secret),
    active: true,
    description: description || null,
    filters: filters || null,
    // Persisted so remove() can clean up the per-owner index, and so the
    // per-subscriber cap enforced in routes/webhooks.js actually has an
    // index to count.
    owner_ip: owner_ip || null,
    created_at: now,
    updated_at: now,
  };
  const redis = cache.getClient();
  await cache.set(key(id), record);
  // A sorted set scored by creation time, not a plain set — mirrors
  // airdropsService/alerts.js's own IDS_KEY pattern, so paginating (added
  // below) walks a deterministic, newest-first order rather than
  // whatever arbitrary order SMEMBERS happened to return (#131).
  await redis.zadd(IDS_KEY, Date.parse(now), id);
  if (owner_ip) {
    await redis.zadd(`webhooks:owner:${owner_ip}`, Date.parse(now), id);
  }
  return normalize(record);
}

async function findById(id) {
  try {
    const record = await cache.get(key(id));
    return normalize(record);
  } catch (err) {
    logger.error('webhookRepository.findById Redis error', { id, error: err.message });
    return null;
  }
}

/** Every webhook, unpaginated — for internal fan-out (listActiveForEvent
 * below), which needs the complete set to notify every subscriber, not a
 * page of it. Not exposed as a public list endpoint; see list() for that. */
async function listAll() {
  try {
    const redis = cache.getClient();
    const ids = await redis.zrevrange(IDS_KEY, 0, -1);
    const records = await Promise.all(ids.map((id) => cache.get(key(id))));
    return records.filter(Boolean).map(normalize);
  } catch (err) {
    logger.error('webhookRepository.listAll Redis error', { error: err.message });
    return [];
  }
}

async function countByOwner(ownerIp) {
  if (!ownerIp) return 0;
  try {
    const redis = cache.getClient();
    return Number(await redis.zcard(`webhooks:owner:${ownerIp}`) || 0);
  } catch (err) {
    logger.error('webhookRepository.countByOwner Redis error', { ownerIp, error: err.message });
    return 0;
  }
}

/** Returns { webhooks, total } — see routes/webhooks.js for how this is
 * wrapped in the canonical pagination envelope. */
async function list(page = 1, limit = 20) {
  try {
    const redis = cache.getClient();
    const total = await redis.zcard(IDS_KEY);
    const start = (page - 1) * limit;
    const end = start + limit - 1;
    const ids = await redis.zrevrange(IDS_KEY, start, end);
    const records = await Promise.all(ids.map((id) => cache.get(key(id))));
    return { webhooks: records.filter(Boolean).map(normalize), total };
  } catch (err) {
    logger.error('webhookRepository.list Redis error', { error: err.message });
    return { webhooks: [], total: 0 };
  }
}

async function listActiveForEvent(eventType, matcher) {
  const all = await listAll();
  return all.filter((w) => w.active && matcher(w.events, eventType));
}

async function update(id, patch) {
  const existing = await cache.get(key(id));
  if (!existing) return null;
  const next = {
    ...existing,
    ...patch,
    // A patched secret arrives as plaintext (validated by webhookPatchBodySchema);
    // re-encrypt it the same way create() does. Omit patch.secret entirely and
    // this correctly falls through to the existing (already-encrypted) value.
    ...(patch.secret ? { secret: encryptSecret(patch.secret) } : {}),
    id: existing.id,
    created_at: existing.created_at,
    updated_at: new Date().toISOString(),
  };
  await cache.set(key(id), next);
  return normalize(next);
}

async function remove(id) {
  const redis = cache.getClient();
  const existing = await cache.get(key(id));
  if (!existing) return null;
  await cache.del(key(id));
  await redis.zrem(IDS_KEY, id);
  if (existing.owner_ip) {
    await redis.zrem(`webhooks:owner:${existing.owner_ip}`, id);
  }
  return normalize(existing);
}

module.exports = {
  countByOwner,
  create,
  findById,
  list,
  listAll,
  listActiveForEvent,
  update,
  remove,
};
