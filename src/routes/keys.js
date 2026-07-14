const express = require('express');
const { requireApiKey } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const apiKeys = require('../services/apiKeys');
const logger = require('../logger');
const AppError = require('../errors/AppError');
const { keyCreateBodySchema, routeIdParamsSchema } = require('../validation/schemas');

const router = express.Router();
const validateRouteIdParams = validate(routeIdParamsSchema, 'params');

router.use('/keys', requireApiKey({ scopes: ['admin'] }));

router.get('/keys', async (_req, res, next) => {
  try {
    const keys = await apiKeys.listKeys();
    return res.json({ keys });
  } catch (err) {
    logger.error('List API keys error', { error: err.message });
    return next(err);
  }
});

router.post('/keys', validate(keyCreateBodySchema), async (req, res, next) => {
  try {
    const { label, scopes } = req.validated.body;

    const created = await apiKeys.createKey({
      label,
      scopes: scopes || ['default'],
    });
    return res.status(201).json(created);
  } catch (err) {
    logger.error('Create API key error', { error: err.message });
    return next(err);
  }
});

router.delete('/keys/:id', validateRouteIdParams, async (req, res, next) => {
  try {
    const deleted = await apiKeys.revokeKey(req.params.id);
    if (!deleted) {
      return next(new AppError('NOT_FOUND', 'API key not found', 404));
    }
    return res.json({ deleted: true, key: deleted });
  } catch (err) {
    logger.error('Revoke API key error', { error: err.message });
    return next(err);
  }
});

module.exports = router;
