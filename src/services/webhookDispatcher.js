'use strict';

const axios = require('axios');
const config = require('../config');
const logger = require('../logger');
const signature = require('./webhookSignature');
const events = require('./webhookEvents');
const webhookRepo = require('../repositories/webhookRepository');
const deliveryRepo = require('../repositories/deliveryRepository');

const USER_AGENT = 'SmartDrop-Webhooks/1.0';

function backoffMs(attemptsCompleted) {
  const base = config.webhooks.retryBaseMs;
  const factor = config.webhooks.retryFactor;
  return base * factor ** (attemptsCompleted - 1);
}

function shouldRetry(responseStatus, networkError) {
  if (networkError) return true;
  if (responseStatus == null) return true;
  if (responseStatus >= 500 && responseStatus < 600) return true;
  if (responseStatus === 408 || responseStatus === 429) return true;
  return false;
}

function buildHeaders(secret, body, eventType, deliveryId) {
  return {
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    'X-SmartDrop-Event': eventType,
    'X-SmartDrop-Delivery': deliveryId,
    'X-SmartDrop-Signature': signature.sign(secret, body),
  };
}

async function postOnce(url, headers, body) {
  return axios.post(url, body, {
    headers,
    timeout: config.webhooks.timeoutMs,
    transformRequest: [(data) => data],
    validateStatus: () => true,
  });
}

async function attempt(deliveryId) {
  const delivery = await deliveryRepo.findById(deliveryId);
  if (!delivery) {
    logger.warn('Delivery missing, dropping retry', { delivery_id: deliveryId });
    return null;
  }
  if (delivery.status === 'success') return delivery;

  const webhook = await webhookRepo.findById(delivery.webhook_id);
  if (!webhook || !webhook.active) {
    return deliveryRepo.update(deliveryId, {
      status: 'failed',
      last_error: 'webhook missing or inactive',
      last_attempt_at: new Date().toISOString(),
      next_retry_at: null,
    });
  }

  const payload = delivery.payload || {
    event: delivery.event_type,
    event_id: delivery.event_id,
    delivery_id: delivery.id,
    occurred_at: delivery.created_at,
  };
  const body = JSON.stringify(payload);
  const headers = buildHeaders(webhook.secret, body, delivery.event_type, delivery.id);

  const attempts = delivery.attempts + 1;
  let responseStatus = null;
  let networkError = null;

  try {
    const res = await postOnce(webhook.url, headers, body);
    responseStatus = res.status;
  } catch (err) {
    networkError = err.message || 'network error';
  }

  const succeeded = responseStatus != null && responseStatus >= 200 && responseStatus < 300;
  const nowIso = new Date().toISOString();

  if (succeeded) {
    logger.info('Webhook delivered', {
      delivery_id: delivery.id,
      webhook_id: webhook.id,
      attempts,
      status: responseStatus,
    });
    return deliveryRepo.update(deliveryId, {
      status: 'success',
      attempts,
      last_attempt_at: nowIso,
      next_retry_at: null,
      last_error: null,
      response_status: responseStatus,
    });
  }

  const errorMessage = networkError || `HTTP ${responseStatus}`;
  const retryable = shouldRetry(responseStatus, Boolean(networkError));
  const hasAttemptsLeft = attempts < config.webhooks.maxAttempts;

  if (retryable && hasAttemptsLeft) {
    const delayMs = backoffMs(attempts);
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    await deliveryRepo.scheduleRetry(delivery.id, Date.now() + delayMs);
    logger.warn('Webhook delivery failed, retry scheduled', {
      delivery_id: delivery.id,
      webhook_id: webhook.id,
      attempts,
      error: errorMessage,
      next_retry_at: nextRetryAt,
    });
    return deliveryRepo.update(deliveryId, {
      status: 'pending',
      attempts,
      last_attempt_at: nowIso,
      next_retry_at: nextRetryAt,
      last_error: errorMessage,
      response_status: responseStatus,
    });
  }

  logger.error('Webhook delivery failed permanently', {
    delivery_id: delivery.id,
    webhook_id: webhook.id,
    attempts,
    error: errorMessage,
  });
  return deliveryRepo.update(deliveryId, {
    status: 'failed',
    attempts,
    last_attempt_at: nowIso,
    next_retry_at: null,
    last_error: errorMessage,
    response_status: responseStatus,
  });
}

async function deliverToWebhook(webhook, eventType, eventId, payload) {
  const delivery = await deliveryRepo.create({
    webhook_id: webhook.id,
    event_id: eventId,
    event_type: eventType,
  });
  await deliveryRepo.update(delivery.id, { payload });
  return attempt(delivery.id);
}

async function dispatch({ event_type: eventType, event_id: eventId, data }) {
  if (!events.isKnownEvent(eventType)) {
    logger.warn('Dispatch skipped, unknown event type', { event_type: eventType });
    return [];
  }
  if (!eventId || typeof eventId !== 'string') {
    throw new Error('event_id is required to dispatch a webhook event');
  }

  const targets = await webhookRepo.listActiveForEvent(eventType, events.matchesSubscription);
  if (targets.length === 0) return [];

  const occurredAt = new Date().toISOString();
  const payload = {
    event: eventType,
    event_id: eventId,
    occurred_at: occurredAt,
    data: data || {},
  };

  return Promise.all(
    targets.map((webhook) => deliverToWebhook(webhook, eventType, eventId, payload))
  );
}

async function sendTest(webhookId) {
  const webhook = await webhookRepo.findById(webhookId);
  if (!webhook) return null;
  const eventType = 'pool.assets_locked';
  const payload = {
    event: eventType,
    event_id: `evt_test_${Date.now()}`,
    occurred_at: new Date().toISOString(),
    data: { test: true, message: 'This is a test delivery from SmartDrop' },
  };
  return deliverToWebhook(webhook, eventType, payload.event_id, payload);
}

module.exports = { dispatch, attempt, sendTest, backoffMs, shouldRetry };
