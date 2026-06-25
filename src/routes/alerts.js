const express = require('express');
const alertsService = require('../services/alerts');
const logger = require('../logger');
const { parsePagination, paginateResponse } = require('../utils/pagination');

const router = express.Router();

const VALID_TYPES = ['above', 'below', 'change_pct'];

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateCreateBody(body) {
  const { asset, type, threshold_usd, webhook_url, webhook_secret } = body;

  if (!asset || typeof asset !== 'string' || !/^[A-Z0-9]{1,12}$/i.test(asset)) {
    return 'asset must be 1-12 alphanumeric characters';
  }
  if (!VALID_TYPES.includes(type)) {
    return `type must be one of: ${VALID_TYPES.join(', ')}`;
  }
  if (typeof threshold_usd !== 'number' || threshold_usd <= 0) {
    return 'threshold_usd must be a positive number';
  }
  if (!webhook_url || !isValidUrl(webhook_url)) {
    return 'webhook_url must be a valid URL';
  }
  if (!webhook_secret || typeof webhook_secret !== 'string' || webhook_secret.length < 8) {
    return 'webhook_secret must be at least 8 characters';
  }
  return null;
}

router.post('/alerts', async (req, res) => {
  try {
    const validationError = validateCreateBody(req.body);
    if (validationError) {
      return res.status(400).json({ error: 'Validation error', message: validationError });
    }

    const alert = await alertsService.create(req.body);
    return res.status(201).json(alert);
  } catch (err) {
    logger.error('Create alert error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/alerts', async (req, res) => {
  try {
    const pagination = parsePagination(req.query);
    const alerts = await alertsService.list();
    const page = alerts.slice(pagination.offset, pagination.offset + pagination.limit);
    return res.json(paginateResponse(page, alerts.length, pagination));
  } catch (err) {
    logger.error('List alerts error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/alerts/:id', async (req, res) => {
  try {
    const deleted = await alertsService.remove(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Alert not found' });
    }
    return res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    logger.error('Delete alert error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
