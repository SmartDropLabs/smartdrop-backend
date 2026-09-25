const crypto = require('crypto');
const cache = require('./cache');
const logger = require('../logger');
const { Horizon } = require('@stellar/stellar-sdk');
const config = require('../config');
const { addRequestIdHeaderInterceptor } = require('../middleware/requestId');

const IDS_KEY = 'airdrops:ids';

function airdropKey(id) {
  return `airdrop:${id}`;
}

function recipientsKey(airdropId) {
  return `airdrop:${airdropId}:recipients`;
}

// Tracks the set of addresses already stored for an airdrop for O(1) cross-request
// duplicate detection. Kept in sync with the recipients list by create/addRecipients/remove.
function recipientAddressSetKey(airdropId) {
  return `airdrop:${airdropId}:addresses`;
}

function generateId() {
  return `drop_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

const horizon = addRequestIdHeaderInterceptor(
  new Horizon.Server(config.stellar.horizonUrl)
);

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
  const { name, description, asset, asset_issuer, total_amount, expiry_ledger, contract_airdrop_id, recipients = [] } = data;

  // #290 — Validate that total_amount matches the sum of recipient amounts.
  // Without this check, an airdrop could be created with a total_amount that
  // doesn't cover all recipients, leading to insufficient on-chain funds.
  if (recipients.length > 0 && total_amount != null) {
    const recipientSum = recipients.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    const total = Number(total_amount);
    if (Math.abs(total - recipientSum) > 1e-7) {
      throw new Error(
        `total_amount (${total_amount}) does not match the sum of recipient amounts (${recipientSum})`,
      );
    }
  }

  const id = generateId();

  const airdrop = {
    id,
    name,
    description,
    asset,
    asset_issuer,
    total_amount,
    expiry_ledger,
    // Linking field: once the on-chain airdrop ID is known (e.g. after the
    // Soroban contract is invoked externally), populate this so the REST
    // record can be correlated with indexer-observed on-chain state (#122).
    contract_airdrop_id: contract_airdrop_id || null,
    status: 'draft',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const redis = cache.getClient();
  // One MULTI/EXEC transaction instead of separate round trips (issue
  // #390) — a crash between cache.set and zadd used to leave an airdrop
  // record with no entry in IDS_KEY (invisible to list/scanIds, so it
  // would never be found again), or an id in IDS_KEY with no backing
  // record (a phantom entry list() would still return and try to re-read
  // as null).
  const multi = redis.multi();
  multi.set(airdropKey(id), JSON.stringify(airdrop));
  multi.zadd(IDS_KEY, Date.now(), id);

  if (recipients.length > 0) {
    multi.rpush(recipientsKey(id), ...recipients.map((r) => JSON.stringify(r)));
    multi.sadd(recipientAddressSetKey(id), ...recipients.map((r) => r.address));
  }

  await multi.exec();

  return airdrop;
}

/**
 * Pages through the full airdrop ID sorted set via ZSCAN instead of ZREVRANGE. Used
 * by the expiry reconciliation job (#88), which needs to visit every
 * airdrop every cycle: ZREVRANGE with 0 -1 returns the whole set in one call
 * and would need it all held in memory at once, which doesn't scale as the
 * set grows. ZSCAN pages incrementally with a small, bounded cursor cost per
 * call. `list()` above is unchanged — this is a separate, job-internal
 * scanning path, not a replacement for the paginated HTTP listing endpoint.
 */
async function* scanIds(batchSize = config.airdrops.expiryScanBatchSize) {
  const redis = cache.getClient();
  let cursor = '0';
  do {
    const [nextCursor, batchWithScores] = await redis.zscan(IDS_KEY, cursor, 'COUNT', batchSize);
    cursor = nextCursor;
    const batch = batchWithScores.filter((_, index) => index % 2 === 0);
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

// Returns { airdrops, total } rather than a full pagination envelope — the
// route layer wraps this in the canonical envelope via
// utils/paginate.js's paginateResponse, the same split routes/alerts.js
// already uses for its own list endpoint (#131).
async function list(page = 1, limit = 20) {
  const redis = cache.getClient();
  const total = await redis.zcard(IDS_KEY);
  const start = (page - 1) * limit;
  const end = start + limit - 1;
  const paginatedIds = await redis.zrevrange(IDS_KEY, start, end);
  const airdrops = await Promise.all(paginatedIds.map((id) => cache.get(airdropKey(id))));

  return { airdrops: airdrops.filter(Boolean), total };
}

async function get(id) {
  return await cache.get(airdropKey(id));
}

async function update(id, data) {
  const airdrop = await get(id);
  if (!airdrop) return null;

  // Terminal statuses cannot be updated — once completed, failed, expired,
  // or cancelled, the airdrop's lifecycle is over (#281).
  const terminalStatuses = ['completed', 'failed', 'expired', 'cancelled'];
  if (terminalStatuses.includes(airdrop.status)) {
    return airdrop;
  }

  const { name, description, expiry_ledger, contract_airdrop_id } = data;
  const updated = {
    ...airdrop,
    name: name !== undefined ? name : airdrop.name,
    description: description !== undefined ? description : airdrop.description,
    expiry_ledger: expiry_ledger !== undefined ? expiry_ledger : airdrop.expiry_ledger,
    contract_airdrop_id: contract_airdrop_id !== undefined ? contract_airdrop_id : airdrop.contract_airdrop_id,
    updated_at: new Date().toISOString(),
  };

  await cache.set(airdropKey(id), updated);
  return updated;
}

async function remove(id) {
  const redis = cache.getClient();
  const existing = await get(id);
  if (!existing) return null;

  // One MULTI/EXEC transaction instead of four separate round trips (issue
  // #305) — a crash partway through used to leave a partially-deleted
  // airdrop: e.g. the main record and recipients list gone but the id still
  // in IDS_KEY (a phantom entry list() would still return and try to
  // re-read as null), or the reverse (a dangling recipients/address-set key
  // with no reachable parent record to ever clean it up again).
  await redis.multi()
    .del(airdropKey(id))
    .del(recipientsKey(id))
    .del(recipientAddressSetKey(id))
    .zrem(IDS_KEY, id)
    .exec();
  return existing;
}

async function cancel(id) {
  const airdrop = await get(id);
  if (!airdrop) return null;

  // Terminal statuses cannot be cancelled — once completed, failed, or
  // expired, the airdrop's lifecycle is over (#280).
  const terminalStatuses = ['completed', 'failed', 'expired', 'cancelled'];
  if (terminalStatuses.includes(airdrop.status)) {
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

// Returns an array of addresses that were already present in a prior call.
// An empty array means all recipients were accepted and stored.
async function addRecipients(airdropId, recipients) {
  const redis = cache.getClient();
  const addresses = recipients.map((r) => r.address);

  // SADD returns 1 for each newly added member, 0 for duplicates. Queued on
  // a single MULTI/EXEC (issue #312) instead of Promise.all-ing N separate
  // SADD calls: the separate calls were each an independent round trip that
  // could interleave with another concurrent request's SADDs on the same
  // key, so two overlapping addRecipients() calls for the same address
  // could each observe "newly added" (both read 1) and double-append it to
  // the recipients list below. MULTI/EXEC runs the whole batch as one
  // atomic, uninterleaved unit, and as a bonus is a single round trip
  // instead of N.
  const multi = redis.multi();
  for (const addr of addresses) {
    multi.sadd(recipientAddressSetKey(airdropId), addr);
  }
  const results = await multi.exec();
  const addedCounts = results.map(([err, count]) => {
    if (err) throw err;
    return count;
  });

  const newAddresses = [];
  const duplicates = [];

  for (let i = 0; i < addresses.length; i++) {
    if (addedCounts[i] === 1) {
      newAddresses.push(recipients[i]);
    } else {
      duplicates.push(addresses[i]);
    }
  }

  if (newAddresses.length > 0) {
    await redis.rpush(recipientsKey(airdropId), ...newAddresses.map((r) => JSON.stringify(r)));
  }

  return duplicates;
}

// Returns { recipients, total } — see list()'s comment above.
async function listRecipients(airdropId, page = 1, limit = 20) {
  const redis = cache.getClient();
  const total = await redis.llen(recipientsKey(airdropId));
  const start = (page - 1) * limit;
  const end = start + limit - 1;
  const serializedRecipients = await redis.lrange(recipientsKey(airdropId), start, end);
  const recipients = serializedRecipients.map((r) => JSON.parse(r));

  return { recipients, total };
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
