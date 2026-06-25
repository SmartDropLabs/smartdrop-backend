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

  await cache.set(airdropKey(airdropId), next);
  await cache.getClient().sadd(AIRDROP_IDS_KEY, airdropId);
}

async function upsertRecipient(event) {
  const airdropId = getAirdropId(event);
  const recipient = getRecipient(event);
  if (!airdropId || !recipient) return;

  const key = recipientsKey(airdropId);
  const recipients = await getJsonList(key);
  const existingIndex = recipients.findIndex((entry) => entry.recipient === recipient);
  const existing = existingIndex >= 0 ? recipients[existingIndex] : { recipient };
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

  if (existingIndex >= 0) recipients[existingIndex] = next;
  else recipients.push(next);

  await setJsonList(key, recipients);
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
  await cache.set(eventKey(event.id), event);
  await cache.getClient().sadd(EVENT_IDS_KEY, event.id);
  await upsertAirdrop(event);
  await upsertRecipient(event);
  await appendClaim(event);
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
  return getJsonList(recipientsKey(airdropId));
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
  setLastLedger,
};
