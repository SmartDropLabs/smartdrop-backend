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
 * Atomicity: `popDueRetries` claims due retries from the `webhooks:retries`
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

function generateId() {
  return `dlv_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

function generateTraceId() {
  return `trace_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

async function create({ webhook_id, event_id, event_type, trace_id, request_id }) {
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
  await cache.set(key(id), record, DELIVERY_TTL_SECONDS);
  await redis.zadd(indexKey(webhook_id), Date.now(), id);
  await redis.zremrangebyrank(indexKey(webhook_id), 0, -(RECENT_DELIVERIES_LIMIT + 1));
  await redis.expire(indexKey(webhook_id), DELIVERY_TTL_SECONDS);
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
  await cache.set(key(id), next, DELIVERY_TTL_SECONDS);
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
    const redis = cache.getClient();
    const ids = await redis.zrevrange(indexKey(webhookId), 0, RECENT_DELIVERIES_LIMIT - 1);
    const records = await Promise.all(ids.map((id) => cache.get(key(id))));
    const deliveries = records.filter(Boolean);
    const filtered = status ? deliveries.filter((delivery) => delivery.status === status) : deliveries;
    return filtered.slice(0, limit);
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
  const redis = cache.getClient();
  await redis.zrem(RETRY_QUEUE_KEY, deliveryId);
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
