const express = require('express');
const { requireApiKey } = require('../middleware/auth');
const apiKeys = require('../services/apiKeys');
const logger = require('../logger');
const AppError = require('../errors/AppError');

const router = express.Router();

router.use('/keys', requireApiKey({ scopes: ['admin'] }));

function validateScopes(scopes) {
  if (scopes === undefined) return null;
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return 'scopes must be a non-empty array of strings';
  }
  if (scopes.some((scope) => typeof scope !== 'string' || !scope.trim())) {
    return 'scopes must be a non-empty array of strings';
  }
  return null;
}

router.get('/keys', async (_req, res, next) => {
  try {
    const keys = await apiKeys.listKeys();
    return res.json({ keys });
  } catch (err) {
    logger.error('List API keys error', { error: err.message });
    return next(err);
  }
});

router.post('/keys', async (req, res, next) => {
  try {
    const { label, scopes } = req.body || {};
    const normalizedLabel = typeof label === 'string' ? label.trim() : '';
    if (!normalizedLabel || normalizedLabel.length > 80) {
      return next(new AppError('VALIDATION_ERROR', 'label must be a non-empty string up to 80 characters', 400));
    }

    const scopeError = validateScopes(scopes);
    if (scopeError) {
      return next(new AppError('VALIDATION_ERROR', scopeError, 400));
    }

    const created = await apiKeys.createKey({
      label: normalizedLabel,
      scopes: scopes ? scopes.map((scope) => scope.trim()) : ['default'],
    });
    return res.status(201).json(created);
  } catch (err) {
    logger.error('Create API key error', { error: err.message });
    return next(err);
  }
});

router.delete('/keys/:id', async (req, res, next) => {
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
