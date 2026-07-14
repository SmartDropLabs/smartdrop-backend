'use strict';

const express = require('express');
const config = require('../config');
const { validate } = require('../middleware/validate');
const webhookRepo = require('../repositories/webhookRepository');
const deliveryRepo = require('../repositories/deliveryRepository');
const dispatcher = require('../services/webhookDispatcher');
const signatureService = require('../services/webhookSignature');
const buildRateLimit = require('../middleware/rateLimit');
const AppError = require('../errors/AppError');
const {
  routeIdParamsSchema,
  webhookCreateBodySchema,
  webhookDeliveriesQuerySchema,
  webhookPatchBodySchema,
} = require('../validation/schemas');

const router = express.Router();
const validateRouteIdParams = validate(routeIdParamsSchema, 'params');

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

router.post('/webhooks', validate(webhookCreateBodySchema), async (req, res, next) => {
  try {
    const body = req.validated.body;
    const secret = body.secret || signatureService.generateSecret();
    const webhook = await webhookRepo.create({
      url: body.url,
      events: body.events,
      secret,
      description: body.description,
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

router.get('/webhooks/:id', validateRouteIdParams, async (req, res, next) => {
  try {
    const webhook = await webhookRepo.findById(req.params.id);
    if (!webhook) return next(new AppError('NOT_FOUND', 'Webhook not found', 404));
    return res.json(publicView(webhook));
  } catch (err) {
    return next(err);
  }
});

router.patch('/webhooks/:id', validateRouteIdParams, validate(webhookPatchBodySchema), async (req, res, next) => {
  try {
    const patch = req.validated.body;
    const updated = await webhookRepo.update(req.params.id, patch);
    if (!updated) return next(new AppError('NOT_FOUND', 'Webhook not found', 404));
    return res.json(publicView(updated));
  } catch (err) {
    return next(err);
  }
});

router.delete('/webhooks/:id', validateRouteIdParams, async (req, res, next) => {
  try {
    const deleted = await webhookRepo.remove(req.params.id);
    if (!deleted) return next(new AppError('NOT_FOUND', 'Webhook not found', 404));
    return res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    return next(err);
  }
});

router.post('/webhooks/:id/test', validateRouteIdParams, testLimit, async (req, res, next) => {
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

router.get('/webhooks/:id/deliveries', validateRouteIdParams, validate(webhookDeliveriesQuerySchema, 'query'), async (req, res, next) => {
  try {
    const webhook = await webhookRepo.findById(req.params.id);
    if (!webhook) return next(new AppError('NOT_FOUND', 'Webhook not found', 404));
    const { limit } = req.validated.query;
    const deliveries = await deliveryRepo.listByWebhook(req.params.id, limit);
    return res.json({ deliveries });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
