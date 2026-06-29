'use strict';

const express = require('express');
const config = require('../config');
const webhookRepo = require('../repositories/webhookRepository');
const deliveryRepo = require('../repositories/deliveryRepository');
const dispatcher = require('../services/webhookDispatcher');
const signatureService = require('../services/webhookSignature');
const events = require('../services/webhookEvents');
const buildRateLimit = require('../middleware/rateLimit');
const AppError = require('../errors/AppError');

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
  } catch {
    return false;
  }
}

function validateCreate(body) {
  if (!body || typeof body !== 'object') return 'body must be an object';
  const { url, events: subscribedEvents, secret, description } = body;
  if (!url || !isValidUrl(url)) return 'url must be a valid http(s) URL';
  if (!events.isValidSubscription(subscribedEvents)) return `events must be a non-empty array of: ${events.ALL_EVENTS.join(', ')} or "*"`;
  if (secret !== undefined && (typeof secret !== 'string' || secret.length < 16)) return 'secret must be a string of at least 16 characters';
  if (description !== undefined && typeof description !== 'string') return 'description must be a string';
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

router.post('/webhooks', async (req, res, next) => {
  try {
    const validationError = validateCreate(req.body);
    if (validationError) return next(new AppError('VALIDATION_ERROR', validationError, 400));

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
    return next(err);
  }
});

router.get('/webhooks', async (_req, res, next) => {
  try {
    const webhooks = await webhookRepo.list();
    return res.json({ webhooks: webhooks.map(publicView) });
  } catch (err) {
    return next(err);
  }
});

router.get('/webhooks/:id', async (req, res, next) => {
  try {
    const webhook = await webhookRepo.findById(req.params.id);
    if (!webhook) return next(new AppError('NOT_FOUND', 'Webhook not found', 404));
    return res.json(publicView(webhook));
  } catch (err) {
    return next(err);
  }
});

router.patch('/webhooks/:id', async (req, res, next) => {
  try {
    const patch = {};
    if (req.body.url !== undefined) {
      if (!isValidUrl(req.body.url)) return next(new AppError('VALIDATION_ERROR', 'url must be a valid http(s) URL', 400));
      patch.url = req.body.url;
    }
    if (req.body.events !== undefined) {
      if (!events.isValidSubscription(req.body.events)) return next(new AppError('VALIDATION_ERROR', 'events invalid', 400));
      patch.events = req.body.events;
    }
    if (req.body.active !== undefined) {
      if (typeof req.body.active !== 'boolean') return next(new AppError('VALIDATION_ERROR', 'active must be boolean', 400));
      patch.active = req.body.active;
    }
    if (req.body.description !== undefined) {
      if (typeof req.body.description !== 'string') return next(new AppError('VALIDATION_ERROR', 'description must be a string', 400));
      patch.description = req.body.description;
    }

    const updated = await webhookRepo.update(req.params.id, patch);
    if (!updated) return next(new AppError('NOT_FOUND', 'Webhook not found', 404));
    return res.json(publicView(updated));
  } catch (err) {
    return next(err);
  }
});

router.delete('/webhooks/:id', async (req, res, next) => {
  try {
    const deleted = await webhookRepo.remove(req.params.id);
    if (!deleted) return next(new AppError('NOT_FOUND', 'Webhook not found', 404));
    return res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    return next(err);
  }
});

router.post('/webhooks/:id/test', testLimit, async (req, res, next) => {
  try {
    const delivery = await dispatcher.sendTest(req.params.id);
    if (!delivery) return next(new AppError('NOT_FOUND', 'Webhook not found', 404));
    return res.status(202).json({
      delivery_id: delivery.id,
      status: delivery.status,
      attempts: delivery.attempts,
      response_status: delivery.response_status,
      last_error: delivery.last_error,
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/webhooks/:id/deliveries', async (req, res, next) => {
  try {
    const webhook = await webhookRepo.findById(req.params.id);
    if (!webhook) return next(new AppError('NOT_FOUND', 'Webhook not found', 404));
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const deliveries = await deliveryRepo.listByWebhook(req.params.id, limit);
    return res.json({ deliveries });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
