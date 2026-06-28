const crypto = require('crypto');
const cache = require('./cache');
const config = require('../config');

const KEY_PREFIX = 'api_key:';
const HASH_PREFIX = 'api_key_hash:';
const IDS_KEY = 'api_keys';

function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

function sanitize(record) {
  if (!record) return null;
  const { key_hash, ...safe } = record;
  return safe;
}

function generateApiKey() {
  return crypto.randomBytes(32).toString('hex');
}

function keyId() {
  return `key_${crypto.randomUUID().replace(/-/g, '')}`;
}

function keyPath(id) {
  return `${KEY_PREFIX}${id}`;
}

function hashPath(hash) {
  return `${HASH_PREFIX}${hash}`;
}

async function getKey(id) {
  return cache.get(keyPath(id));
}

async function listKeys() {
  const redis = cache.getClient();
  const ids = await redis.smembers(IDS_KEY);
  const records = await Promise.all(ids.map((id) => getKey(id)));
  return records.filter(Boolean).map(sanitize);
}

async function createKey({ label, scopes = ['default'] }) {
  const apiKey = generateApiKey();
  const hashed = hashApiKey(apiKey);
  const now = new Date().toISOString();
  const record = {
    id: keyId(),
    label,
    key_prefix: apiKey.slice(0, 8),
    key_hash: hashed,
    scopes,
    created_at: now,
    last_used_at: null,
  };

  const redis = cache.getClient();
  await cache.set(keyPath(record.id), record);
  await cache.set(hashPath(hashed), record.id);
  await redis.sadd(IDS_KEY, record.id);

  return {
    api_key: apiKey,
    key: sanitize(record),
  };
}

async function revokeKey(id) {
  const record = await getKey(id);
  if (!record) return null;

  const redis = cache.getClient();
  await cache.del(keyPath(id));
  await cache.del(hashPath(record.key_hash));
  await redis.srem(IDS_KEY, id);
  return sanitize(record);
}

async function touch(record) {
  const updated = {
    ...record,
    last_used_at: new Date().toISOString(),
  };
  await cache.set(keyPath(record.id), updated);
  return sanitize(updated);
}

async function validateApiKey(apiKey) {
  if (!apiKey) return null;

  if (config.auth.adminApiKey && apiKey === config.auth.adminApiKey) {
    return {
      id: 'admin',
      label: 'Bootstrap admin key',
      key_prefix: apiKey.slice(0, 8),
      scopes: ['admin'],
      created_at: null,
      last_used_at: new Date().toISOString(),
    };
  }

  const hashed = hashApiKey(apiKey);
  const id = await cache.get(hashPath(hashed));
  if (!id) return null;

  const record = await getKey(id);
  if (!record || record.key_hash !== hashed) return null;

  return touch(record);
}

module.exports = {
  createKey,
  getKey,
  hashApiKey,
  listKeys,
  revokeKey,
  validateApiKey,
};
