const crypto = require('crypto');
const cache = require('./cache');
const logger = require('../logger');
const { Horizon } = require('stellar-sdk');
const config = require('../config');

const IDS_KEY = 'airdrops:ids';

function airdropKey(id) {
  return `airdrop:${id}`;
}

function recipientsKey(airdropId) {
  return `airdrop:${airdropId}:recipients`;
}

function generateId() {
  return `drop_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

const horizon = new Horizon.Server(config.stellar.horizonUrl);

// getCurrentLedger() is a live Horizon call. Callers that need to check many
// airdrops in quick succession (the expiry reconciliation job, in
// particular — see #88) would otherwise issue one Horizon request per
// airdrop per cycle; cache the result briefly so bursts of calls within the
// same window reuse one ledger read instead of hammering Horizon, the same
// rate-limit concern already applied to CoinGecko/CoinMarketCap elsewhere.
let cachedLedger = null;
let cachedLedgerAt = 0;

async function getCurrentLedger() {
  const now = Date.now();
  if (cachedLedger !== null && now - cachedLedgerAt < config.airdrops.ledgerCacheTtlMs) {
    return cachedLedger;
  }

  const ledger = await horizon.ledgers().order('desc').limit(1).call();
  cachedLedger = ledger.records[0].sequence;
  cachedLedgerAt = now;
  return cachedLedger;
}

async function create(data) {
  const { name, description, asset, asset_issuer, total_amount, expiry_ledger, recipients = [] } = data;
  const id = generateId();

  const airdrop = {
    id,
    name,
    description,
    asset,
    asset_issuer,
    total_amount,
    expiry_ledger,
    status: 'draft',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const redis = cache.getClient();
  await cache.set(airdropKey(id), airdrop);
  await redis.sadd(IDS_KEY, id);

  if (recipients.length > 0) {
    await redis.lpush(recipientsKey(id), ...recipients.map((r) => JSON.stringify(r)));
  }

  return airdrop;
}

/**
 * Pages through the full airdrop ID set via SSCAN instead of SMEMBERS. Used
 * by the expiry reconciliation job (#88), which needs to visit every
 * airdrop every cycle: SMEMBERS returns the whole set in one blocking call
 * and would need it all held in memory at once, which doesn't scale as the
 * set grows. SSCAN pages incrementally with a small, bounded cursor cost per
 * call. `list()` above is unchanged — this is a separate, job-internal
 * scanning path, not a replacement for the paginated HTTP listing endpoint.
 */
async function* scanIds(batchSize = config.airdrops.expiryScanBatchSize) {
  const redis = cache.getClient();
  let cursor = '0';
  do {
    const [nextCursor, batch] = await redis.sscan(IDS_KEY, cursor, 'COUNT', batchSize);
    cursor = nextCursor;
    if (batch.length > 0) {
      yield batch;
    }
  } while (cursor !== '0');
}

// Statuses an airdrop cannot leave once reached.
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'expired']);

/**
 * Atomically transitions an airdrop to 'expired' if — and only if — it's
 * still in a non-terminal status *and* its expiry_ledger has actually
 * passed, checked and written in a single Lua script so two processes (or
 * two overlapping job cycles) racing on the same airdrop can't both "win"
 * and each fire a duplicate webhook. Returns the updated airdrop on a
 * successful transition, or null if nothing changed (already terminal, not
 * yet expired, or the airdrop doesn't exist) — callers use that to decide
 * whether to dispatch a webhook.
 */
const MARK_EXPIRED_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return false end
local airdrop = cjson.decode(raw)
local terminal = { completed = true, failed = true, cancelled = true, expired = true }
if terminal[airdrop.status] then return false end
if not airdrop.expiry_ledger or tonumber(airdrop.expiry_ledger) > tonumber(ARGV[1]) then
  return false
end
airdrop.status = 'expired'
airdrop.updated_at = ARGV[2]
local updated = cjson.encode(airdrop)
redis.call('SET', KEYS[1], updated)
return updated
`;

async function markExpired(id, currentLedger) {
  const redis = cache.getClient();
  const result = await redis.eval(
    MARK_EXPIRED_SCRIPT,
    1,
    airdropKey(id),
    currentLedger,
    new Date().toISOString(),
  );
  if (!result) return null;
  return JSON.parse(result);
}

async function list(page = 1, limit = 20) {
  const redis = cache.getClient();
  const ids = await redis.smembers(IDS_KEY);
  const start = (page - 1) * limit;
  const end = start + limit;
  const paginatedIds = ids.slice(start, end);
  const airdrops = await Promise.all(paginatedIds.map((id) => cache.get(airdropKey(id))));

  return {
    airdrops: airdrops.filter(Boolean),
    pagination: {
      page,
      limit,
      total: ids.length,
      total_pages: Math.ceil(ids.length / limit),
    },
  };
}

async function get(id) {
  return await cache.get(airdropKey(id));
}

async function update(id, data) {
  const airdrop = await get(id);
  if (!airdrop) return null;

  const { name, description, expiry_ledger } = data;
  const updated = {
    ...airdrop,
    name: name !== undefined ? name : airdrop.name,
    description: description !== undefined ? description : airdrop.description,
    expiry_ledger: expiry_ledger !== undefined ? expiry_ledger : airdrop.expiry_ledger,
    updated_at: new Date().toISOString(),
  };

  await cache.set(airdropKey(id), updated);
  return updated;
}

async function remove(id) {
  const redis = cache.getClient();
  const existing = await get(id);
  if (!existing) return null;

  await cache.del(airdropKey(id));
  await cache.del(recipientsKey(id));
  await redis.srem(IDS_KEY, id);
  return existing;
}

async function cancel(id) {
  const airdrop = await get(id);
  if (!airdrop) return null;

  if (airdrop.status === 'cancelled') {
    return airdrop;
  }

  const updated = {
    ...airdrop,
    status: 'cancelled',
    updated_at: new Date().toISOString(),
  };

  await cache.set(airdropKey(id), updated);
  return updated;
}

async function addRecipients(airdropId, recipients) {
  const redis = cache.getClient();
  await redis.rpush(recipientsKey(airdropId), ...recipients.map((r) => JSON.stringify(r)));
}

async function listRecipients(airdropId, page = 1, limit = 20) {
  const redis = cache.getClient();
  const total = await redis.llen(recipientsKey(airdropId));
  const start = (page - 1) * limit;
  const end = start + limit - 1;
  const serializedRecipients = await redis.lrange(recipientsKey(airdropId), start, end);
  const recipients = serializedRecipients.map((r) => JSON.parse(r));

  return {
    recipients,
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit),
    },
  };
}

module.exports = {
  create,
  list,
  get,
  update,
  remove,
  cancel,
  addRecipients,
  listRecipients,
  getCurrentLedger,
  scanIds,
  markExpired,
  TERMINAL_STATUSES,
};
