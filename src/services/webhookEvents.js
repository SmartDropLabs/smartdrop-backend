'use strict';

const POOL_EVENTS = Object.freeze([
  'pool.created',
  'pool.assets_locked',
  'pool.assets_unlocked',
  'pool.rewards_distributed',
  'pool.closed',
]);

const PRICE_EVENTS = Object.freeze(['price.alert']);

// Only 'airdrop.failed' is registered here — it's the one event this
// codebase actually dispatches today (the expiry reconciliation job, #88).
// The README also documents airdrop.created/executing/completed, but
// nothing in the codebase dispatches those yet; registering unused event
// names here would let a client subscribe to something that can never
// fire, so they're left out until whatever feature actually dispatches
// them lands.
const AIRDROP_EVENTS = Object.freeze(['airdrop.failed']);

const ALL_EVENTS = Object.freeze([...POOL_EVENTS, ...PRICE_EVENTS, ...AIRDROP_EVENTS]);
const EVENT_SET = new Set(ALL_EVENTS);

const WILDCARD = '*';
const MAX_EXPLICIT_SUBSCRIPTIONS = 25;

function isKnownEvent(eventType) {
  return typeof eventType === 'string' && EVENT_SET.has(eventType);
}

function isValidSubscription(events) {
  if (!Array.isArray(events) || events.length === 0) return false;
  if (events.length === 1 && events[0] === WILDCARD) return true;
  if (events.includes(WILDCARD)) return false;
  if (events.length > MAX_EXPLICIT_SUBSCRIPTIONS) return false;
  return events.every((e) => e === WILDCARD || EVENT_SET.has(e));
}

function matchesSubscription(subscribedEvents, eventType) {
  if (!Array.isArray(subscribedEvents) || subscribedEvents.length === 0) return false;
  if (subscribedEvents.includes(WILDCARD)) return true;
  return subscribedEvents.includes(eventType);
}

// Envelope fields every delivered event carries (see README "Webhook payload").
// Per-event data requirements: only airdrop.failed has a documented data field.
const REQUIRED_DATA_FIELDS = new Map([
  ['airdrop.failed', ['reason']],
]);

/**
 * Validate an outgoing webhook event envelope before it is delivered.
 *
 * @param {unknown} payload - { event, event_id, occurred_at, data }
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateEventPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: ['payload must be an object'] };
  }
  const errors = [];
  if (!isKnownEvent(payload.event)) {
    errors.push('event must be a known event type');
  }
  if (typeof payload.event_id !== 'string' || payload.event_id.length === 0) {
    errors.push('event_id must be a non-empty string');
  }
  if (typeof payload.occurred_at !== 'string' || Number.isNaN(Date.parse(payload.occurred_at))) {
    errors.push('occurred_at must be an ISO-8601 timestamp');
  }
  if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
    errors.push('data must be an object');
  } else if (REQUIRED_DATA_FIELDS.has(payload.event)) {
    for (const field of REQUIRED_DATA_FIELDS.get(payload.event)) {
      const value = payload.data[field];
      if (value === undefined || value === null || value === '') {
        errors.push(`data.${field} is required for ${payload.event}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  validateEventPayload,
  POOL_EVENTS,
  PRICE_EVENTS,
  AIRDROP_EVENTS,
  ALL_EVENTS,
  WILDCARD,
  MAX_EXPLICIT_SUBSCRIPTIONS,
  isKnownEvent,
  isValidSubscription,
  matchesSubscription,
};
