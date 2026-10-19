'use strict';

/**
 * Webhook delivery log repository.
 *
 * Schema mirrors the future PostgreSQL `webhook_deliveries` table:
 *
 *   webhook_deliveries (
 *     id               text primary key,
 *     webhook_id       text not null references webhooks(id) on delete cascade,
 *     event_id         text not null,
 *     event_type       text not null,
 *     status           text not null,        -- pending | success | failed
 *     attempts         int  not null default 0,
 *     last_error       text,
 *     last_attempt_at  timestamptz,
 *     next_retry_at    timestamptz,
 *     response_status  int,
 *     trace_id         text not null,
 *     request_id       text,                 -- originating HTTP request (issue #250)
 *     created_at       timestamptz not null default now()
 *   )
 *
 * Indexes that would back the queries below:
 *   (webhook_id, created_at desc)   - listing recent deliveries per webhook
 *   (next_retry_at)                 - retry worker scan
 *
 * Redis key layout:
 *   webhook_delivery:<id>            JSON record, 30-day TTL
 *   webhook:<id>:deliveries          ZSET of ids scored by creation time
 *   webhook:<id>:deliveries:<status> ZSET of ids for one status (issue #359)
 *   webhooks:retries                 ZSET of ids due for retry
 *
 * Atomicity: `create` and `update` commit their record write and every index
 * write in one MULTI/EXEC (issues #358/#359) — the record and its index
 * entries can never disagree because of a crash mid-sequence. `popDueRetries`
 * claims due retries from the `webhooks:retries`
 * sorted set via a single Lua script (ZRANGEBYSCORE + ZREM in one round
 * trip), registered on the ioredis client with `defineCommand`. Redis
 * executes Lua scripts single-threaded to completion, so N instances of
 * this backend calling `popDueRetries` concurrently against the same Redis
 * always receive a disjoint set of ids - no delivery is ever claimed by
 * more than one instance. This makes `webhookRetryWorker` safe to run on
 * multiple replicas without duplicate delivery attempts.
 */

const crypto = require('crypto');
const cache = require('../services/cache');
const logger = require('../logger');
const webhookRepository = require('./webhookRepository');

const RETRY_QUEUE_KEY = 'webhooks:retries';
const RECENT_DELIVERIES_LIMIT = 100;
// Delivery records are kept for 30 days, after which they're no longer useful
// for debugging and their unbounded accumulation would exhaust Redis memory.
const DELIVERY_TTL_SECONDS = 30 * 24 * 60 * 60;

// Atomically claims up to ARGV[2] due members (score <= ARGV[1]) from the
// sorted set at KEYS[1] and removes them in the same round trip, so
// concurrent callers can never be handed overlapping ids.
const POP_DUE_RETRIES_LUA = `
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
if #ids > 0 then
  redis.call('ZREM', KEYS[1], unpack(ids))
end
return ids
`;

function ensurePopDueRetriesCommand(redis) {
  if (typeof redis.popDueRetriesAtomic !== 'function') {
    redis.defineCommand('popDueRetriesAtomic', { numberOfKeys: 1, lua: POP_DUE_RETRIES_LUA });
  }
}

function key(id) {
  return `webhook_delivery:${id}`;
}

function indexKey(webhookId) {
  return `webhook:${webhookId}:deliveries`;
}

// Issue #359 — per-status index so a `?status=` listing is answered from
// Redis instead of hydrating the whole recent window and discarding most of
// it in JS. Same shape as webhookRepository's per-event index (#369): a
// sorted set of delivery ids per (webhook, status), scored by creation time
// so it keeps the identical newest-first ordering as the unfiltered index.
//
// A delivery joins its status index on create (status "pending") and moves
// with every status transition, so ids written before this key existed
// self-heal on their next write. Only deliveries that were already terminal
// when this shipped are absent from a status-filtered listing; the
// unfiltered listing (indexKey) is unaffected.
function statusIndexKey(webhookId, status) {
  return `webhook:${webhookId}:deliveries:${status}`;
}

/**
 * Queues one index write onto `multi`: insert the id, trim the zset back to
 * RECENT_DELIVERIES_LIMIT newest members, and (re)arm the TTL so index
 * pointers can never outlive the records they point at. Both the unfiltered
 * index and the per-status index go through here, so they stay capped and
 * expiring identically.
 */
function queueIndexWrite(multi, index, score, id) {
  multi.zadd(index, score, id);
  multi.zremrangebyrank(index, 0, -(RECENT_DELIVERIES_LIMIT + 1));
  multi.expire(index, DELIVERY_TTL_SECONDS);
}

function generateId() {
  return `dlv_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

function generateTraceId() {
  return `trace_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

async function create({ webhook_id, event_id, event_type, trace_id, request_id }) {
  // Validate webhook exists before creating delivery to prevent orphaned records (#411).
  if (!webhook_id) {
    throw new Error('deliveryRepository.create: webhook_id is required');
  }
  const webhook = await webhookRepository.findById(webhook_id);
  if (!webhook) {
    throw new Error(`deliveryRepository.create: webhook '${webhook_id}' does not exist`);
  }

  const id = generateId();
  const now = new Date().toISOString();
  const record = {
    id,
    webhook_id,
    event_id,
    event_type,
    status: 'pending',
    attempts: 0,
    last_error: null,
    last_attempt_at: null,
    next_retry_at: null,
    response_status: null,
    trace_id: trace_id || generateTraceId(),
    // Correlates this delivery back to the HTTP request that triggered it
    // (issue #250). Null for deliveries originated by background jobs,
    // which have no inbound request.
    request_id: request_id || null,
    created_at: now,
  };

  const redis = cache.getClient();
  // Issue #358: record write + index insert + index trim + index TTL used to
  // be four separate awaited round trips (cache.set, ZADD, ZREMRANGEBYRANK,
  // EXPIRE). Dying between them left an id in the index pointing at no record
  // — a phantom that listByWebhook silently dropped — or a record no listing
  // could ever find. Everything here is computed from the arguments alone (no
  // prior state is read to produce any of it), so the whole batch commits as
  // one MULTI/EXEC.
  const score = Date.parse(now);
  const multi = redis.multi().set(key(id), JSON.stringify(record), 'EX', DELIVERY_TTL_SECONDS);
  queueIndexWrite(multi, indexKey(webhook_id), score, id);
  // #359 — mirror the id into the status index so ?status= queries read only
  // the ids they can actually return.
  queueIndexWrite(multi, statusIndexKey(webhook_id, record.status), score, id);
  await multi.exec();
  return record;
}

async function findById(id) {
  try {
    return await cache.get(key(id));
  } catch (err) {
    logger.error('deliveryRepository.findById Redis error', { id, error: err.message });
    return null;
  }
}

async function update(id, patch) {
  const existing = await cache.get(key(id));
  if (!existing) return null;
  const next = { ...existing, ...patch, id: existing.id };
  const redis = cache.getClient();
  // The record write and the status-index move commit together: a delivery
  // flipping pending → success/failed must land in the new status index in
  // the same transaction that records the new status, otherwise a
  // status-filtered listing could disagree with the stored record (the id
  // would be missing from the index it now belongs to, or left in the one it
  // just left).
  const multi = redis.multi().set(key(id), JSON.stringify(next), 'EX', DELIVERY_TTL_SECONDS);
  // #359 — re-index when the status changes. The score stays the creation
  // timestamp, so ordering within a status index matches the unfiltered one.
  if (patch.status && patch.status !== existing.status && existing.webhook_id) {
    if (existing.status) {
      multi.zrem(statusIndexKey(existing.webhook_id, existing.status), id);
    }
    queueIndexWrite(
      multi,
      statusIndexKey(existing.webhook_id, patch.status),
      Date.parse(existing.created_at) || Date.now(),
      id,
    );
  }
  await multi.exec();
  return next;
}

function normalizeListOptions(limitOrOptions, statusArg) {
  if (typeof limitOrOptions === 'number') {
    return { limit: limitOrOptions, status: statusArg || null };
  }

  if (limitOrOptions && typeof limitOrOptions === 'object') {
    return {
      limit: limitOrOptions.limit ?? 50,
      status: limitOrOptions.status || null,
    };
  }

  return { limit: 50, status: statusArg || null };
}

async function listByWebhook(webhookId, limitOrOptions = 50, statusArg) {
  try {
    const { limit, status } = normalizeListOptions(limitOrOptions, statusArg);
    // `limit` bounds how many ids we even look at: the old code always read
    // the full recent window (RECENT_DELIVERIES_LIMIT ids), hydrated every
    // record behind it and only then threw most of them away in JS.
    const requested = Number(limit);
    const take = Number.isFinite(requested) ? Math.max(0, Math.trunc(requested)) : 0;
    if (take === 0) return [];
    const redis = cache.getClient();
    // Issue #359: when filtering by status, read the per-status index — Redis
    // has already narrowed the set to ids that can actually be returned, so
    // we hydrate at most `limit` matching records instead of up to 100
    // records of every status.
    const index = status ? statusIndexKey(webhookId, status) : indexKey(webhookId);
    const ids = await redis.zrevrange(index, 0, take - 1);
    if (ids.length === 0) return [];
    // One MGET round trip for the page instead of one GET per record.
    const records = await cache.mget(ids.map(key));
    // Drop ids whose record has already expired out from under its index
    // entry (both carry the same TTL, but the index is capped and refreshed
    // on write).
    return records.filter(Boolean);
  } catch (err) {
    logger.error('deliveryRepository.listByWebhook Redis error', { webhookId, error: err.message });
    return [];
  }
}

async function scheduleRetry(deliveryId, nextRetryAtMs) {
  const redis = cache.getClient();
  await redis.zadd(RETRY_QUEUE_KEY, nextRetryAtMs, deliveryId);
}

async function popDueRetries(nowMs, max = 25) {
  const redis = cache.getClient();
  ensurePopDueRetriesCommand(redis);
  return redis.popDueRetriesAtomic(RETRY_QUEUE_KEY, nowMs, max);
}

/**
 * Number of deliveries currently sitting in the retry queue (issue #235).
 *
 * Counts the whole sorted set, not just entries already due, so operators
 * see retries backing up before they come due rather than after.
 */
async function countPendingRetries() {
  try {
    const redis = cache.getClient();
    return await redis.zcard(RETRY_QUEUE_KEY);
  } catch (err) {
    logger.error('deliveryRepository.countPendingRetries Redis error', { error: err.message });
    return null;
  }
}

async function cancelRetry(deliveryId) {
  // #371 — verify the delivery exists before attempting removal so callers
  // get a clear signal when the ID is invalid or the delivery was never
  // scheduled for retry.
  const delivery = await findById(deliveryId);
  if (!delivery) {
    return { removed: false, reason: 'delivery not found' };
  }
  const redis = cache.getClient();
  const removed = await redis.zrem(RETRY_QUEUE_KEY, deliveryId);
  return { removed: removed === 1, reason: removed === 1 ? 'ok' : 'not in retry queue' };
}

module.exports = {
  create,
  findById,
  update,
  listByWebhook,
  scheduleRetry,
  popDueRetries,
  countPendingRetries,
  cancelRetry,
};
