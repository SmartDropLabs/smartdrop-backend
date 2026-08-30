'use strict';

const cache = require('./cache');
const config = require('../config');
const logger = require('../logger');
const webhookRepo = require('../repositories/webhookRepository');
const webhookService = require('./webhook');

const DLQ_INDEX_KEY = 'webhooks:dlq';
const DLQ_ENTRY_PREFIX= 'webhook_dlq:';
const DLQ_TTL_SECONDS = config.webhooks.dlqTtlSeconds || 7 * 24 * 60 * 60;

function entryKey(id) {
  return `${DLQ_ENTRY_PREFIX}${id}`;
}

async function add(delivery, options = {}) {
  const id = delivery.id;
  const errorHistory = Array.isArray(options.errorHistory) && options.errorHistory.length > 0
    ? options.errorHistory
    : (delivery.last_error
        ? [{ error: delivery.last_error, attempted_at: delivery.last_attempt_at || new Date().toISOString() }]
        : []);

  const entry = {
    id,
    delivery,
    payload: options.payload !== undefined ? options.payload : null,
    error_history: errorHistory,
    attempts: delivery.attempts || 0,
    last_error: delivery.last_error || null,
    queued_at: new Date().toISOString(),
  };

  await cache.set(entryKey(id), entry, DLQ_TTL_SECONDS);
  await cache.getClient().zadd(DLQ_INDEX_KEY, Date.now(), id);
  return entry;
}

async function list() {
  const redis = cache.getClient();
  const ids = await redis.zrevrange(DLQ_INDEX_KEY, 0, -1);
  const entries = [];
  for (const id of ids) {
    const entry = await cache.get(entryKey(id));
    if (entry) {
      entries.push(entry);
    } else {
      await redis.zdem(DLQ_INDEX_KEY, id);
    }
  }
  return entries;
}

async function findById(id) {
  return cache.get(entryKey(id));
}

async function remove(id) {
  const redis = cache.getClient();
  await cache.del(entryKey(id));
  await redis.zrem(DLQ_INDEX_KEY, id);
}

async function retry(id) {
  const entry = await findById(id);
  if (!entry) {
    const err = new Error('DLQ dentry not found');
    err.status = 404;
    throw err;
  }

  const webhook = await webhookRepo.findById(entry.delivery.webhook_id);
  if (!webhook) {
    throw new Error(`Webhook not found for DLQ entry ${id}`);
  }

  const payload = entry.payload || {};
  const startedAt = Date.now();
  let result;
  try {
    result = await webhookService.sendSignedRequest(webhook.url, webhook.secret, payload, {
      timeoutMs: config.webhooks.timeoutMs || 10000,
    });
  } catch (err) {
    result = { ok: false, error: err.message, duration_ms: Date.now() - startedAt };
  }

  const attemptRecord = {
    attempted_at: new Date().toISOString(),
    duration_ms: result.duration_ms || 0,
    status: result.ok ? 'success' : 'failed',
    response_status: result.status || null,
    error: result.error || null,
  };

  const updatedEntry = {
    ...entry,
    attempts: entry.attempts + 1,
    last_error: result.ok ? null : (result.error || (result.status ? `HTTP ${result.status}` : 'Delivery failed')),
    error_history: Array.isArray(entry.error_history) ? [...entry.error_history, attemptRecord] : [attemptRecord],
    last_attempt_at: attemptRecord.attempted_at,
  };

  if (result.ok) {
    await remove(id);
    logger.info('DLQ dentry retried successfully', { dlq_id: id, webhook_id: webhook.id });
    return { retried: true, success: true, entry: updatedEntry };
  }

  await cache.set(entryKey(id), updatedEntry, DLQ_TTL_SECONDS);
  logger.warn('DLQ dentry retry failed', { dlq_id: id, error: updatedEntry.last_error });
  return { retried: true, success: false, entry: updatedEntry };
}

module.exports = { add, list, findById, remove, retry };