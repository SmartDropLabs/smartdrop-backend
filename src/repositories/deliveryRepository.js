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
 *     created_at       timestamptz not null default now()
 *   )
 *
 * Indexes that would back the queries below:
 *   (webhook_id, created_at desc)   - listing recent deliveries per webhook
 *   (next_retry_at)                 - retry worker scan
 */

const crypto = require('crypto');
const cache = require('../services/cache');

const RETRY_QUEUE_KEY = 'webhooks:retries';
const RECENT_DELIVERIES_LIMIT = 100;

function key(id) {
  return `webhook_delivery:${id}`;
}

function indexKey(webhookId) {
  return `webhook:${webhookId}:deliveries`;
}

function generateId() {
  return `dlv_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

async function create({ webhook_id, event_id, event_type }) {
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
    created_at: now,
  };

  const redis = cache.getClient();
  await cache.set(key(id), record);
  await redis.zadd(indexKey(webhook_id), Date.now(), id);
  await redis.zremrangebyrank(indexKey(webhook_id), 0, -(RECENT_DELIVERIES_LIMIT + 1));
  return record;
}

async function findById(id) {
  return cache.get(key(id));
}

async function update(id, patch) {
  const existing = await cache.get(key(id));
  if (!existing) return null;
  const next = { ...existing, ...patch, id: existing.id };
  await cache.set(key(id), next);
  return next;
}

async function listByWebhook(webhookId, limit = 50) {
  const redis = cache.getClient();
  const ids = await redis.zrevrange(indexKey(webhookId), 0, Math.max(0, limit - 1));
  const records = await Promise.all(ids.map((id) => cache.get(key(id))));
  return records.filter(Boolean);
}

async function scheduleRetry(deliveryId, nextRetryAtMs) {
  const redis = cache.getClient();
  await redis.zadd(RETRY_QUEUE_KEY, nextRetryAtMs, deliveryId);
}

async function popDueRetries(nowMs, max = 25) {
  const redis = cache.getClient();
  const ids = await redis.zrangebyscore(RETRY_QUEUE_KEY, '-inf', nowMs, 'LIMIT', 0, max);
  if (ids.length === 0) return [];
  await redis.zrem(RETRY_QUEUE_KEY, ...ids);
  return ids;
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
  cancelRetry,
};
