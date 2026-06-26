
'use strict';

const express = require('express');
const logger = require('../logger');
const config = require('../config');
const webhookRepo = require('../repositories/webhookRepository');
const deliveryRepo = require('../repositories/deliveryRepository');
const dispatcher = require('../services/webhookDispatcher');
const signatureService = require('../services/webhookSignature');
const events = require('../services/webhookEvents');
const buildRateLimit = require('../middleware/rateLimit');

const router = express.Router();

const manageLimit = buildRateLimit({
  windowSeconds: config.webhooks.rateLimit.windowSeconds,
  max: config.webhooks.rateLimit.max,
  keyPrefix: 'webhooks',
});

const testLimit = buildRateLimit({
  windowSeconds: config.webhooks.testRateLimit.windowSeconds,
  max: config.webhooks.testRateLimit.max,
  keyPrefix: 'webhooks_test',
});

router.use('/webhooks', manageLimit);

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';

const express = require('express');
const webhooks = require('../services/webhooks');
const logger = require('../logger');

const router = express.Router();

function isValidUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';

  } catch {
    return false;
  }
}


function validateCreate(body) {
  if (!body || typeof body !== 'object') return 'body must be an object';
  const { url, events: subscribedEvents, secret, description } = body;

  if (!url || !isValidUrl(url)) {
    return 'url must be a valid http(s) URL';
  }
  if (!events.isValidSubscription(subscribedEvents)) {
    return `events must be a non-empty array of: ${events.ALL_EVENTS.join(', ')} or "*"`;
  }
  if (secret !== undefined) {
    if (typeof secret !== 'string' || secret.length < 16) {
      return 'secret must be a string of at least 16 characters';
    }
  }
  if (description !== undefined && typeof description !== 'string') {
    return 'description must be a string';

function validateEndpoint(body) {
  if (!body || !isValidUrl(body.url)) {
    return 'url must be a valid HTTP or HTTPS URL';
  }
  if (!Array.isArray(body.events) || body.events.length === 0) {
    return 'events must be a non-empty array';
  }
  if (body.events.some((event) => !webhooks.VALID_EVENTS.includes(event))) {
    return `events must be one of: ${webhooks.VALID_EVENTS.join(', ')}`;
  }
  if (!body.secret || typeof body.secret !== 'string' || body.secret.length < 8) {
    return 'secret must be at least 8 characters';

  }
  return null;
}


function publicView(webhook) {
  if (!webhook) return null;
  return {
    id: webhook.id,
    url: webhook.url,
    events: webhook.events,
    active: webhook.active,
    description: webhook.description,
    created_at: webhook.created_at,
    updated_at: webhook.updated_at,
    secret_preview: webhook.secret ? `${webhook.secret.slice(0, 10)}…` : null,
  };
}

router.post('/webhooks', async (req, res) => {
  try {
    const validationError = validateCreate(req.body);

router.post('/webhooks', async (req, res) => {
  try {
    const validationError = validateEndpoint(req.body);

    if (validationError) {
      return res.status(400).json({ error: 'Validation error', message: validationError });
    }


    const secret = req.body.secret || signatureService.generateSecret();
    const webhook = await webhookRepo.create({
      url: req.body.url,
      events: req.body.events,
      secret,
      description: req.body.description,
    });

    return res.status(201).json({
      ...publicView(webhook),
      secret,
      secret_warning: 'Store this secret now — it will not be shown again in plaintext.',
    });
  } catch (err) {
    logger.error('Create webhook error', { error: err.message });

    const endpoint = await webhooks.createEndpoint({
      url: req.body.url,
      events: [...new Set(req.body.events)],
      secret: req.body.secret,
    });

    return res.status(201).json(endpoint);
  } catch (err) {
    logger.error('Create webhook endpoint error', { error: err.message });

    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/webhooks', async (_req, res) => {
  try {

    const webhooks = await webhookRepo.list();
    return res.json({ webhooks: webhooks.map(publicView) });
  } catch (err) {
    logger.error('List webhooks error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/webhooks/:id', async (req, res) => {
  try {
    const webhook = await webhookRepo.findById(req.params.id);
    if (!webhook) return res.status(404).json({ error: 'Webhook not found' });
    return res.json(publicView(webhook));
  } catch (err) {
    logger.error('Get webhook error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/webhooks/:id', async (req, res) => {
  try {
    const patch = {};
    if (req.body.url !== undefined) {
      if (!isValidUrl(req.body.url)) {
        return res.status(400).json({ error: 'Validation error', message: 'url must be a valid http(s) URL' });
      }
      patch.url = req.body.url;
    }
    if (req.body.events !== undefined) {
      if (!events.isValidSubscription(req.body.events)) {
        return res.status(400).json({ error: 'Validation error', message: 'events invalid' });
      }
      patch.events = req.body.events;
    }
    if (req.body.active !== undefined) {
      if (typeof req.body.active !== 'boolean') {
        return res.status(400).json({ error: 'Validation error', message: 'active must be boolean' });
      }
      patch.active = req.body.active;
    }
    if (req.body.description !== undefined) {
      if (typeof req.body.description !== 'string') {
        return res.status(400).json({ error: 'Validation error', message: 'description must be a string' });
      }
      patch.description = req.body.description;
    }

    const updated = await webhookRepo.update(req.params.id, patch);
    if (!updated) return res.status(404).json({ error: 'Webhook not found' });
    return res.json(publicView(updated));
  } catch (err) {
    logger.error('Update webhook error', { error: err.message });

    const endpoints = await webhooks.listEndpoints();
    return res.json({ webhooks: endpoints });
  } catch (err) {
    logger.error('List webhook endpoints error', { error: err.message });

    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/webhooks/:id', async (req, res) => {
  try {

    const deleted = await webhookRepo.remove(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Webhook not found' });
    return res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    logger.error('Delete webhook error', { error: err.message });

    const deleted = await webhooks.removeEndpoint(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Webhook endpoint not found' });
    }
    return res.json({ deleted: true, webhook: deleted });
  } catch (err) {
    logger.error('Delete webhook endpoint error', { error: err.message });

    return res.status(500).json({ error: 'Internal server error' });
  }
});


router.post('/webhooks/:id/test', testLimit, async (req, res) => {
  try {
    const delivery = await dispatcher.sendTest(req.params.id);
    if (!delivery) return res.status(404).json({ error: 'Webhook not found' });
    return res.status(202).json({
      delivery_id: delivery.id,
      status: delivery.status,
      attempts: delivery.attempts,
      response_status: delivery.response_status,
      last_error: delivery.last_error,
    });
  } catch (err) {
    logger.error('Test webhook error', { error: err.message });

router.post('/webhooks/:id/test', async (req, res) => {
  try {
    const delivery = await webhooks.sendTestPing(req.params.id);
    if (!delivery) {
      return res.status(404).json({ error: 'Webhook endpoint not found' });
    }
    return res.status(202).json({ delivery });
  } catch (err) {
    logger.error('Test webhook delivery error', { error: err.message });

    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/webhooks/:id/deliveries', async (req, res) => {
  try {

    const webhook = await webhookRepo.findById(req.params.id);
    if (!webhook) return res.status(404).json({ error: 'Webhook not found' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const deliveries = await deliveryRepo.listByWebhook(req.params.id, limit);
    return res.json({ deliveries });
  } catch (err) {
    logger.error('List deliveries error', { error: err.message });

    const endpoint = await webhooks.getEndpoint(req.params.id);
    if (!endpoint || !endpoint.active) {
      return res.status(404).json({ error: 'Webhook endpoint not found' });
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const deliveries = await webhooks.listDeliveries(req.params.id, limit);
    return res.json({ deliveries });
  } catch (err) {
    logger.error('List webhook deliveries error', { error: err.message });

    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
