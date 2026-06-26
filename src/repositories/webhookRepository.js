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

const IDS_KEY = 'webhooks:ids';

function key(id) {
  return `webhook:${id}`;
}

function generateId() {
  return `wh_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

function normalize(record) {
  if (!record) return null;
  return {
    id: record.id,
    url: record.url,
    events: Array.isArray(record.events) ? [...record.events] : [],
    secret: record.secret,
    active: record.active !== false,
    description: record.description || null,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

async function create({ url, events, secret, description }) {
  const id = generateId();
  const now = new Date().toISOString();
  const record = {
    id,
    url,
    events,
    secret,
    active: true,
    description: description || null,
    created_at: now,
    updated_at: now,
  };
  const redis = cache.getClient();
  await cache.set(key(id), record);
  await redis.sadd(IDS_KEY, id);
  return normalize(record);
}

async function findById(id) {
  const record = await cache.get(key(id));
  return normalize(record);
}

async function list() {
  const redis = cache.getClient();
  const ids = await redis.smembers(IDS_KEY);
  const records = await Promise.all(ids.map((id) => cache.get(key(id))));
  return records.filter(Boolean).map(normalize);
}

async function listActiveForEvent(eventType, matcher) {
  const all = await list();
  return all.filter((w) => w.active && matcher(w.events, eventType));
}

async function update(id, patch) {
  const existing = await cache.get(key(id));
  if (!existing) return null;
  const next = {
    ...existing,
    ...patch,
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
  await redis.srem(IDS_KEY, id);
  return normalize(existing);
}

module.exports = {
  create,
  findById,
  list,
  listActiveForEvent,
  update,
  remove,
};
