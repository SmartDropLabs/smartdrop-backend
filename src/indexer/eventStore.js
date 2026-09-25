const cache = require('../services/cache');

const EVENT_IDS_KEY = 'indexer:contract_events:ids';
const LAST_LEDGER_KEY = 'indexer:last_ledger';
const AIRDROP_IDS_KEY = 'indexer:airdrops:ids';

function eventKey(id) {
  return `indexer:contract_event:${id}`;
}

function airdropKey(id) {
  return `indexer:airdrop:${id}`;
}

function recipientsKey(id) {
  return `indexer:airdrop:${id}:recipients`;
}

function claimsKey(address) {
  return `indexer:recipient:${address}:claims`;
}

async function getJsonList(key) {
  return (await cache.get(key)) || [];
}

async function setJsonList(key, list) {
  await cache.set(key, list);
}

function getAirdropId(event) {
  return event && event.data ? event.data.airdrop_id : null;
}

function getRecipient(event) {
  return event && event.data ? event.data.recipient : null;
}

async function getLastLedger(defaultLedger = 0) {
  const saved = await cache.get(LAST_LEDGER_KEY);
  if (saved === null || saved === undefined || saved === '') return defaultLedger;
  const parsed = Number(saved);
  return Number.isFinite(parsed) ? parsed : defaultLedger;
}

async function setLastLedger(ledger) {
  await cache.set(LAST_LEDGER_KEY, Number(ledger));
}

async function upsertAirdrop(event) {
  const airdropId = getAirdropId(event);
  if (!airdropId) return;

  const existing = (await cache.get(airdropKey(airdropId))) || { airdrop_id: airdropId };
  const next = {
    ...existing,
    updated_ledger: event.ledger,
    updated_at: event.ledger_closed_at,
  };

  if (event.event_name === 'airdrop_created') {
    Object.assign(next, {
      status: 'created',
      creator: event.data.creator ?? existing.creator ?? null,
      token: event.data.token ?? existing.token ?? null,
      total_amount: event.data.total_amount ?? existing.total_amount ?? null,
      expiry_ledger: event.data.expiry_ledger ?? existing.expiry_ledger ?? null,
      created_ledger: event.ledger,
      created_at: event.ledger_closed_at,
    });
  }

  if (event.event_name === 'token_claimed') {
    next.status = existing.status === 'expired' ? 'expired' : 'active';
  }

  if (event.event_name === 'airdrop_expired') {
    Object.assign(next, {
      status: 'expired',
      unclaimed_amount: event.data.unclaimed_amount ?? null,
      expired_ledger: event.ledger,
      expired_at: event.ledger_closed_at,
    });
  }

  // Issue #354: a single MULTI/EXEC transaction instead of two separate
  // round trips — a crash between them used to leave an airdrop record
  // with no entry in AIRDROP_IDS_KEY (invisible to anything that scans the
  // id set) or vice versa (an id with no backing record).
  await cache.getClient().multi()
    .set(airdropKey(airdropId), JSON.stringify(next))
    .sadd(AIRDROP_IDS_KEY, airdropId)
    .exec();
}

// Issue #353: recipients used to be stored as one JSON-list string per
// airdrop, so every single-recipient upsert had to load the ENTIRE list
// into memory (O(n) per event) just to update one entry. Each recipient is
// now its own field in a Redis hash keyed by airdrop id, so an upsert is
// one HGET + one HSET (O(1)), regardless of how many recipients the
// airdrop has.
//
// A key that predates this fix still holds the old JSON-list string, and
// HGET/HSET on a String-typed key raises WRONGTYPE — this migrates it,
// once, lazily on first access, rather than requiring a manual operator
// step before deploying.
async function migrateRecipientsListToHashIfNeeded(key) {
  const redis = cache.getClient();
  const type = await redis.type(key);
  if (type !== 'string') return;

  const list = await getJsonList(key);
  await redis.del(key);
  if (list.length === 0) return;

  const pipeline = redis.pipeline();
  for (const entry of list) {
    if (entry && entry.recipient) {
      pipeline.hset(key, entry.recipient, JSON.stringify(entry));
    }
  }
  await pipeline.exec();
}

async function upsertRecipient(event) {
  const airdropId = getAirdropId(event);
  const recipient = getRecipient(event);
  if (!airdropId || !recipient) return;

  const key = recipientsKey(airdropId);
  await migrateRecipientsListToHashIfNeeded(key);

  const redis = cache.getClient();
  const existingRaw = await redis.hget(key, recipient);
  const existing = existingRaw ? JSON.parse(existingRaw) : { recipient };
  const next = {
    ...existing,
    airdrop_id: airdropId,
    amount: event.data.amount ?? existing.amount ?? null,
    updated_ledger: event.ledger,
    updated_at: event.ledger_closed_at,
  };

  if (event.event_name === 'recipient_added') {
    next.status = existing.status || 'pending';
    next.added_ledger = event.ledger;
  }

  if (event.event_name === 'token_claimed') {
    next.status = 'claimed';
    next.claimed_ledger = event.data.ledger ?? event.ledger;
    next.claimed_at = event.ledger_closed_at;
  }

  await redis.hset(key, recipient, JSON.stringify(next));
}

async function appendClaim(event) {
  const recipient = getRecipient(event);
  const airdropId = getAirdropId(event);
  if (event.event_name !== 'token_claimed' || !recipient || !airdropId) return;

  const key = claimsKey(recipient);
  const claims = await getJsonList(key);
  if (!claims.some((claim) => claim.event_id === event.id)) {
    claims.push({
      event_id: event.id,
      airdrop_id: airdropId,
      recipient,
      amount: event.data.amount ?? null,
      ledger: event.data.ledger ?? event.ledger,
      claimed_at: event.ledger_closed_at,
    });
    await setJsonList(key, claims);
  }
}

async function saveEvent(event) {
  // Issue #352: the raw event record and its id-set membership are written
  // in one MULTI/EXEC transaction — a crash between them used to leave an
  // event id in EVENT_IDS_KEY with no backing record, or a record with no
  // id-set entry (invisible to getEventCount()). upsertAirdrop/
  // upsertRecipient/appendClaim below each read-then-write their own
  // separate keys (their prior values determine what gets written), so
  // they can't join this same transaction — see #354 and #353 for their
  // own atomicity/scalability fixes.
  await cache.getClient().multi()
    .set(eventKey(event.id), JSON.stringify(event))
    .sadd(EVENT_IDS_KEY, event.id)
    .exec();
  await upsertAirdrop(event);
  await upsertRecipient(event);
  await appendClaim(event);
}

/**
 * Batch-writes a poll cycle's events instead of one store round trip per
 * event (issue #314). The raw event records go through a single Redis
 * pipeline; the derived airdrop/recipient/claim projections still need
 * their own read-modify-write per event (multiple events in one batch can
 * target the same airdrop), so those stay sequential to preserve
 * chronological ordering.
 */
async function saveEvents(events) {
  if (!events || events.length === 0) return;

  const redis = cache.getClient();
  const pipeline = redis.pipeline();
  for (const event of events) {
    pipeline.set(eventKey(event.id), JSON.stringify(event));
    pipeline.sadd(EVENT_IDS_KEY, event.id);
  }
  await pipeline.exec();

  for (const event of events) {
    await upsertAirdrop(event);
    await upsertRecipient(event);
    await appendClaim(event);
  }
}

async function getAirdropStatus(airdropId) {
  const status = await cache.get(airdropKey(airdropId));
  if (!status) return null;

  const recipients = await getAirdropRecipients(airdropId);
  const claimed_count = recipients.filter((recipient) => recipient.status === 'claimed').length;

  return {
    ...status,
    recipients_count: recipients.length,
    claimed_count,
    pending_count: recipients.length - claimed_count,
  };
}

async function getAirdropRecipients(airdropId) {
  const key = recipientsKey(airdropId);
  await migrateRecipientsListToHashIfNeeded(key);

  const redis = cache.getClient();
  const raw = await redis.hgetall(key);
  const recipients = Object.values(raw).map((v) => JSON.parse(v));
  // A hash has no guaranteed iteration order across calls; sort by
  // added_ledger (falling back to recipient address) so pagination here
  // stays stable, matching the old JSON-list's insertion order.
  recipients.sort((a, b) => {
    const la = a.added_ledger ?? 0;
    const lb = b.added_ledger ?? 0;
    if (la !== lb) return la - lb;
    return String(a.recipient).localeCompare(String(b.recipient));
  });
  return recipients;
}

async function getRecipientClaims(address) {
  return getJsonList(claimsKey(address));
}

async function getEventCount() {
  const ids = await cache.getClient().smembers(EVENT_IDS_KEY);
  return ids.length;
}

async function getStats() {
  const [lastLedger, eventsCount] = await Promise.all([
    getLastLedger(0),
    getEventCount(),
  ]);

  return {
    last_ledger: lastLedger,
    events_count: eventsCount,
  };
}

module.exports = {
  getAirdropRecipients,
  getAirdropStatus,
  getLastLedger,
  getRecipientClaims,
  getStats,
  saveEvent,
  saveEvents,
  setLastLedger,
};
