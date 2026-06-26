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

router.post('/webhooks', async (req, res) => {
  try {
    const validationError = validateEndpoint(req.body);
    if (validationError) {
      return res.status(400).json({ error: 'Validation error', message: validationError });
    }

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
    const endpoints = await webhooks.listEndpoints();
    return res.json({ webhooks: endpoints });
  } catch (err) {
    logger.error('List webhook endpoints error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/webhooks/:id', async (req, res) => {
  try {
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
