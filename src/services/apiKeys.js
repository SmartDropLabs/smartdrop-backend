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

// Hard ceiling on unbounded list queries (issue #530).
const MAX_LIST_LIMIT = 1000;

async function listKeys() {
  const redis = cache.getClient();
  const ids = await redis.zrevrange(IDS_KEY, 0, -1);
  if (ids.length === 0) return [];
  const records = await cache.mget(ids.map(keyPath));
  const now = Date.now();
  return records
    .filter((record) => record && (!record.expires_at || Date.parse(record.expires_at) > now))
    .map(sanitize);
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
  const multi = redis.multi();
  multi.set(keyPath(record.id), JSON.stringify(record));
  multi.set(hashPath(hashed), record.id);
  multi.zadd(IDS_KEY, Date.now(), record.id);
  await multi.exec();

  return {
    api_key: apiKey,
    key: sanitize(record),
  };
}

async function revokeKey(id) {
  const record = await getKey(id);
  if (!record) return null;

  const redis = cache.getClient();
  const multi = redis.multi();
  multi.del(keyPath(id));
  multi.del(hashPath(record.key_hash));
  multi.zrem(IDS_KEY, id);
  await multi.exec();
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
    rotated_at: now,
    rotated_from: oldRecord.id,
    rotation_count: (oldRecord.rotation_count || 0) + 1,
    last_used_at: null,
  };

  const configuredGrace = Number.isFinite(options.gracePeriodSeconds)
    ? options.gracePeriodSeconds
    : config.auth.apiKeyRotationGraceSeconds;
  const graceSeconds = Math.max(0, configuredGrace);
  const redis = cache.getClient();
  const multi = redis.multi();

  multi.set(keyPath(newRecord.id), JSON.stringify(newRecord));
  multi.set(hashPath(hashed), newRecord.id);
  multi.zadd(IDS_KEY, Date.now(), newRecord.id);

  let previousKeyExpiresAt = null;
  if (graceSeconds > 0) {
    previousKeyExpiresAt = new Date(Date.now() + graceSeconds * 1000).toISOString();
    const retiredRecord = {
      ...oldRecord,
      revoked_at: now,
      expires_at: previousKeyExpiresAt,
      rotated_to: newRecord.id,
    };
    multi.set(keyPath(id), JSON.stringify(retiredRecord));
    multi.zadd(IDS_KEY, Date.now(), id);
  } else {
    multi.del(keyPath(id));
    multi.del(hashPath(oldRecord.key_hash));
    multi.zrem(IDS_KEY, id);
  }

  await multi.exec();

  return {
    api_key: newApiKey,
    key: sanitize(newRecord),
    rotated_from: sanitize(oldRecord),
    previous_key_expires_at: previousKeyExpiresAt,
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

  if (record.expires_at && Date.parse(record.expires_at) <= Date.now()) {
    const redis = cache.getClient();
    const multi = redis.multi();
    multi.del(keyPath(record.id));
    multi.del(hashPath(record.key_hash));
    multi.zrem(IDS_KEY, record.id);
    await multi.exec();
    return null;
  }

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
