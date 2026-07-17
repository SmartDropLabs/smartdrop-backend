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
};
