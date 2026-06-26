const express = require('express');
const { requireApiKey } = require('../middleware/auth');
const apiKeys = require('../services/apiKeys');
const logger = require('../logger');

const router = express.Router();

router.use(requireApiKey({ scopes: ['admin'] }));

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

router.get('/keys', async (_req, res) => {
  try {
    const keys = await apiKeys.listKeys();
    return res.json({ keys });
  } catch (err) {
    logger.error('List API keys error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/keys', async (req, res) => {
  try {
    const { label, scopes } = req.body || {};
    const normalizedLabel = typeof label === 'string' ? label.trim() : '';
    if (!normalizedLabel || normalizedLabel.length > 80) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'label must be a non-empty string up to 80 characters',
      });
    }

    const scopeError = validateScopes(scopes);
    if (scopeError) {
      return res.status(400).json({ error: 'Validation error', message: scopeError });
    }

    const created = await apiKeys.createKey({
      label: normalizedLabel,
      scopes: scopes ? scopes.map((scope) => scope.trim()) : ['default'],
    });
    return res.status(201).json(created);
  } catch (err) {
    logger.error('Create API key error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/keys/:id', async (req, res) => {
  try {
    const deleted = await apiKeys.revokeKey(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'API key not found' });
    }
    return res.json({ deleted: true, key: deleted });
  } catch (err) {
    logger.error('Revoke API key error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
