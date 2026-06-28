'use strict';

const POOL_EVENTS = Object.freeze([
  'pool.created',
  'pool.assets_locked',
  'pool.assets_unlocked',
  'pool.rewards_distributed',
  'pool.closed',
]);

const PRICE_EVENTS = Object.freeze(['price.alert']);

const ALL_EVENTS = Object.freeze([...POOL_EVENTS, ...PRICE_EVENTS]);
const EVENT_SET = new Set(ALL_EVENTS);

const WILDCARD = '*';

function isKnownEvent(eventType) {
  return typeof eventType === 'string' && EVENT_SET.has(eventType);
}

function isValidSubscription(events) {
  if (!Array.isArray(events) || events.length === 0) return false;
  return events.every((e) => e === WILDCARD || EVENT_SET.has(e));
}

function matchesSubscription(subscribedEvents, eventType) {
  if (!Array.isArray(subscribedEvents) || subscribedEvents.length === 0) return false;
  if (subscribedEvents.includes(WILDCARD)) return true;
  return subscribedEvents.includes(eventType);
}

module.exports = {
  POOL_EVENTS,
  PRICE_EVENTS,
  ALL_EVENTS,
  WILDCARD,
  isKnownEvent,
  isValidSubscription,
  matchesSubscription,
};
