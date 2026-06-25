const crypto = require('crypto');
const { scValToNative } = require('stellar-sdk');

const EVENT_FIELDS = {
  airdrop_created: ['airdrop_id', 'creator', 'token', 'total_amount', 'expiry_ledger'],
  recipient_added: ['airdrop_id', 'recipient', 'amount'],
  token_claimed: ['airdrop_id', 'recipient', 'amount', 'ledger'],
  airdrop_expired: ['airdrop_id', 'unclaimed_amount'],
};

const EVENT_NAMES = Object.keys(EVENT_FIELDS);

function toJsonSafe(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, toJsonSafe(val)]));
  }
  return value;
}

function xdrBase64(scVal) {
  if (!scVal || typeof scVal.toXDR !== 'function') return null;
  return scVal.toXDR('base64');
}

function decodeScVal(scVal) {
  if (scVal === undefined || scVal === null) return null;
  return toJsonSafe(scValToNative(scVal));
}

function normalizeEventName(value) {
  if (typeof value !== 'string') return null;
  return EVENT_NAMES.includes(value) ? value : null;
}

function dataFromValue(eventName, value, topicHintCount = 0) {
  if (value && !Array.isArray(value) && typeof value === 'object') {
    return value;
  }

  const fields = EVENT_FIELDS[eventName];
  if (Array.isArray(value)) {
    const valueFields = topicHintCount > 0 && value.length < fields.length
      ? fields.slice(fields.length - value.length)
      : fields;

    return Object.fromEntries(valueFields.map((field, index) => [field, value[index] ?? null]));
  }

  return { value };
}

function mergeTopicHints(eventName, data, topics) {
  const eventNameIndex = topics.findIndex((topic) => topic === eventName);
  const topicHints = eventNameIndex >= 0 ? topics.slice(eventNameIndex + 1) : [];
  const merged = { ...data };

  if (merged.airdrop_id == null && topicHints[0] != null) merged.airdrop_id = topicHints[0];
  if (merged.recipient == null && topicHints[1] != null) merged.recipient = topicHints[1];

  return merged;
}

function eventId(event) {
  if (event.id) return String(event.id);
  const fallback = `${event.ledger}:${event.pagingToken}:${JSON.stringify(event.topic || [])}`;
  return crypto.createHash('sha256').update(fallback).digest('hex');
}

function contractIdToString(contractId) {
  if (!contractId) return null;
  if (typeof contractId === 'string') return contractId;
  if (typeof contractId.toString === 'function') return contractId.toString();
  return String(contractId);
}

function parseContractEvent(event) {
  const nativeTopics = (event.topic || []).map(decodeScVal);
  const eventName = nativeTopics.map(normalizeEventName).find(Boolean);

  if (!eventName) return null;

  const decodedValue = decodeScVal(event.value);
  const eventNameIndex = nativeTopics.findIndex((topic) => topic === eventName);
  const topicHintCount = eventNameIndex >= 0 ? nativeTopics.length - eventNameIndex - 1 : 0;
  const data = mergeTopicHints(eventName, dataFromValue(eventName, decodedValue, topicHintCount), nativeTopics);

  return {
    id: eventId(event),
    event_name: eventName,
    type: event.type,
    ledger: event.ledger,
    ledger_closed_at: event.ledgerClosedAt || null,
    paging_token: event.pagingToken || null,
    contract_id: contractIdToString(event.contractId),
    in_successful_contract_call: event.inSuccessfulContractCall !== false,
    data,
    decoded: {
      topics: nativeTopics,
      value: decodedValue,
    },
    raw_xdr: {
      topics: (event.topic || []).map(xdrBase64),
      value: xdrBase64(event.value),
    },
    indexed_at: new Date().toISOString(),
  };
}

module.exports = {
  EVENT_FIELDS,
  EVENT_NAMES,
  decodeScVal,
  parseContractEvent,
  toJsonSafe,
};
