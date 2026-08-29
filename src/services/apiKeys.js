const crypto = require("crypto");
const cache = require("./cache");
const config = require("../config");

const KEY_PREFIX = "api_key:";
const HASH_PREFIX = "api_key_hash:";
const IDS_KEY = "api_keys";

function hashApiKey(apiKey) {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

function constantTimeSecretEqual(actual, expected) {
  const actualDigest = crypto.createHash("sha256").update(actual).digest();
  const expectedDigest = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(actualDigest, expectedDigest);
}

function sanitize(record) {
  if (!record) return null;
  const { key_hash, ...safe } = record;
  return safe;
}

function generateApiKey() {
  return crypto.randomBytes(32).toString("hex");
}

function keyId() {
  return `key_${crypto.randomUUID().replace(/-/g, "")}`;
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
  const ids = await redis.zrevrange(IDS_KEY, 0, -1);
  const records = await Promise.all(ids.map((id) => getKey(id)));
  return records.filter(Boolean).map(sanitize);
}

function normalizeTier(tier) {
  const tiers = config.apiKeyRateLimit.tiers;
  if (
    typeof tier === "string" &&
    Object.prototype.hasOwnProperty.call(tiers, tier)
  ) {
    return tier;
  }
  return config.apiKeyRateLimit.defaultTier;
}

async function createKey({ label, scopes = ["default"], tier }) {
  const apiKey = generateApiKey();
  const hashed = hashApiKey(apiKey);
  const now = new Date().toISOString();
  const record = {
    id: keyId(),
    label,
    key_prefix: apiKey.slice(0, 8),
    key_hash: hashed,
    scopes,
    // Sizes this key's own rate limit bucket (issue #251).
    tier: normalizeTier(tier),
    created_at: now,
    last_used_at: null,
  };

  const redis = cache.getClient();
  await cache.set(keyPath(record.id), record);
  await cache.set(hashPath(hashed), record.id);
  await redis.zadd(IDS_KEY, Date.now(), record.id);

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
  await redis.zrem(IDS_KEY, id);
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

async function rotateKey(id, options = {}) {
  const oldRecord = await getKey(id);
  if (!oldRecord) return null;

  // Create new key with same label and scopes, but allow tier override
  const newApiKey = generateApiKey();
  const hashed = hashApiKey(newApiKey);
  const now = new Date().toISOString();
  const newRecord = {
    id: keyId(),
    label: oldRecord.label,
    key_prefix: newApiKey.slice(0, 8),
    key_hash: hashed,
    scopes: oldRecord.scopes,
    tier: options.tier ? normalizeTier(options.tier) : oldRecord.tier,
    created_at: now,
    last_used_at: null,
  };

  const redis = cache.getClient();

  // Create new key first
  await cache.set(keyPath(newRecord.id), newRecord);
  await cache.set(hashPath(hashed), newRecord.id);
  await redis.zadd(IDS_KEY, Date.now(), newRecord.id);

  // Then revoke old key
  await cache.del(keyPath(id));
  await cache.del(hashPath(oldRecord.key_hash));
  await redis.zrem(IDS_KEY, id);

  return {
    api_key: newApiKey,
    key: sanitize(newRecord),
    rotated_from: sanitize(oldRecord),
  };
}

async function validateApiKey(apiKey) {
  if (!apiKey) return null;

  if (
    config.auth.adminApiKey &&
    constantTimeSecretEqual(apiKey, config.auth.adminApiKey)
  ) {
    return {
      id: "admin",
      label: "Bootstrap admin key",
      key_prefix: apiKey.slice(0, 8),
      scopes: ["admin"],
      tier: "admin",
      created_at: null,
      last_used_at: new Date().toISOString(),
    };
  }

  const hashed = hashApiKey(apiKey);
  const id = await cache.get(hashPath(hashed));
  if (!id) return null;

  const record = await getKey(id);
  if (!record || record.key_hash !== hashed) return null;

  // Keys created before tiers existed have no `tier`; resolve them to the
  // default tier rather than leaving the rate limiter to guess.
  if (!record.tier) {
    record.tier = config.apiKeyRateLimit.defaultTier;
  }

  return touch(record);
}

module.exports = {
  createKey,
  getKey,
  hashApiKey,
  listKeys,
  normalizeTier,
  rotateKey,
  revokeKey,
  validateApiKey,
};
