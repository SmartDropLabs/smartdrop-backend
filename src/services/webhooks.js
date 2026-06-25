const crypto = require('crypto');
const cache = require('./cache');
const webhook = require('./webhook');
const logger = require('../logger');

const ENDPOINT_IDS_KEY = 'webhooks:endpoints';
const DEAD_LETTER_IDS_KEY = 'webhooks:dead_letters';
const DELIVERY_ATTEMPTS = 5;
const BACKOFF_MS = [1000, 5000, 30000, 120000, 600000];
const VALID_EVENTS = [
  'airdrop.created',
  'airdrop.executing',
  'airdrop.completed',
  'airdrop.failed',
  'recipient.claimed',
];

function endpointKey(id) {
  return `webhook:endpoint:${id}`;
}

function deliveriesKey(endpointId) {
  return `webhook:endpoint:${endpointId}:deliveries`;
}

function deliveryKey(id) {
  return `webhook:delivery:${id}`;
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function secretPreview(secret) {
  if (!secret) return null;
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function publicEndpoint(endpoint) {
  if (!endpoint) return null;
  const { secret, ...rest } = endpoint;
  return {
    ...rest,
    secret_preview: secretPreview(secret),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createEndpoint(data) {
  const endpoint = {
    id: id('wh'),
    url: data.url,
    events: data.events,
    secret: data.secret,
    active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  await cache.set(endpointKey(endpoint.id), endpoint);
  await cache.getClient().sadd(ENDPOINT_IDS_KEY, endpoint.id);

  return publicEndpoint(endpoint);
}

async function getEndpoint(id) {
  return cache.get(endpointKey(id));
}

async function listEndpoints() {
  const ids = await cache.getClient().smembers(ENDPOINT_IDS_KEY);
  const endpoints = await Promise.all(ids.map(getEndpoint));
  return endpoints.filter(Boolean).map(publicEndpoint);
}

async function removeEndpoint(id) {
  const endpoint = await getEndpoint(id);
  if (!endpoint) return null;

  endpoint.active = false;
  endpoint.updated_at = new Date().toISOString();
  await cache.set(endpointKey(id), endpoint);
  await cache.getClient().srem(ENDPOINT_IDS_KEY, id);

  return publicEndpoint(endpoint);
}

function makeDelivery(endpoint, event, payload) {
  return {
    id: id('dlv'),
    endpoint_id: endpoint.id,
    event,
    payload,
    status: 'pending',
    attempt_count: 0,
    attempts: [],
    next_retry_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function saveDelivery(delivery) {
  delivery.updated_at = new Date().toISOString();
  await cache.set(deliveryKey(delivery.id), delivery);
  await cache.getClient().sadd(deliveriesKey(delivery.endpoint_id), delivery.id);
}

async function markDeadLetter(delivery) {
  delivery.status = 'dead_letter';
  delivery.next_retry_at = null;
  await saveDelivery(delivery);
  await cache.getClient().sadd(DEAD_LETTER_IDS_KEY, delivery.id);
}

async function recordAttempt(delivery, attempt) {
  delivery.attempt_count = attempt.attempt;
  delivery.attempts.push(attempt);
  delivery.status = attempt.ok ? 'delivered' : 'failed';
  delivery.next_retry_at = attempt.next_retry_at || null;
  await saveDelivery(delivery);
}

async function processDelivery(endpoint, event, payload, options = {}) {
  const delivery = options.delivery || makeDelivery(endpoint, event, payload);
  const transport = options.transport || webhook.sendSignedRequest;
  const wait = options.sleep || sleep;
  const maxAttempts = options.maxAttempts || DELIVERY_ATTEMPTS;

  await saveDelivery(delivery);

  for (let attemptNumber = delivery.attempt_count + 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
    try {
      const result = await transport(endpoint.url, endpoint.secret, payload, { timeoutMs: 10000 });
      const ok = result.ok === true;
      const shouldRetry = !ok && attemptNumber < maxAttempts;
      const nextRetryAt = shouldRetry
        ? new Date(Date.now() + BACKOFF_MS[attemptNumber - 1]).toISOString()
        : null;

      await recordAttempt(delivery, {
        attempt: attemptNumber,
        ok,
        status: ok ? 'delivered' : 'failed',
        response_code: result.status || null,
        error: ok ? null : `HTTP ${result.status}`,
        duration_ms: result.duration_ms || null,
        created_at: new Date().toISOString(),
        next_retry_at: nextRetryAt,
      });

      if (ok) return delivery;
      if (!shouldRetry) break;
      await wait(BACKOFF_MS[attemptNumber - 1]);
    } catch (err) {
      const shouldRetry = attemptNumber < maxAttempts;
      const nextRetryAt = shouldRetry
        ? new Date(Date.now() + BACKOFF_MS[attemptNumber - 1]).toISOString()
        : null;

      await recordAttempt(delivery, {
        attempt: attemptNumber,
        ok: false,
        status: 'failed',
        response_code: err.response ? err.response.status : null,
        error: err.message,
        duration_ms: err.duration_ms || null,
        created_at: new Date().toISOString(),
        next_retry_at: nextRetryAt,
      });

      if (!shouldRetry) break;
      await wait(BACKOFF_MS[attemptNumber - 1]);
    }
  }

  await markDeadLetter(delivery);
  logger.warn('Webhook delivery moved to dead letter queue', {
    delivery_id: delivery.id,
    endpoint_id: endpoint.id,
    event,
  });
  return delivery;
}

async function queueDelivery(endpoint, event, payload) {
  const delivery = makeDelivery(endpoint, event, payload);
  await saveDelivery(delivery);

  setImmediate(() => {
    processDelivery(endpoint, event, payload, { delivery }).catch((err) => {
      logger.error('Webhook background delivery failed', {
        delivery_id: delivery.id,
        endpoint_id: endpoint.id,
        error: err.message,
      });
    });
  });

  return delivery;
}

async function deliverEvent(event, payload) {
  const endpoints = await Promise.all((await cache.getClient().smembers(ENDPOINT_IDS_KEY)).map(getEndpoint));
  const deliveries = [];

  for (const endpoint of endpoints.filter(Boolean)) {
    if (!endpoint.active || !endpoint.events.includes(event)) continue;
    deliveries.push(await queueDelivery(endpoint, event, payload));
  }

  return deliveries;
}

async function sendTestPing(endpointId) {
  const endpoint = await getEndpoint(endpointId);
  if (!endpoint || !endpoint.active) return null;

  return queueDelivery(endpoint, 'ping', {
    event: 'ping',
    timestamp: new Date().toISOString(),
  });
}

async function listDeliveries(endpointId, limit = 50) {
  const ids = await cache.getClient().smembers(deliveriesKey(endpointId));
  const deliveries = (await Promise.all(ids.map((deliveryId) => cache.get(deliveryKey(deliveryId)))))
    .filter(Boolean)
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  return deliveries.slice(0, limit);
}

module.exports = {
  BACKOFF_MS,
  DELIVERY_ATTEMPTS,
  VALID_EVENTS,
  createEndpoint,
  deliverEvent,
  getEndpoint,
  listDeliveries,
  listEndpoints,
  processDelivery,
  removeEndpoint,
  sendTestPing,
};
