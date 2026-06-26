const express = require('express');
const { requireApiKey } = require('../middleware/auth');
const priceOracle = require('../services/priceOracle');
const logger = require('../logger');

const router = express.Router();

function validateAssetCode(assetCode) {
  if (!assetCode || typeof assetCode !== 'string') return false;
  if (assetCode.length < 1 || assetCode.length > 12) return false;
  return /^[A-Z0-9]+$/.test(assetCode);
}

function validateIssuer(issuer) {
  if (!issuer) return true;
  return /^G[A-Z0-9]{55}$/.test(issuer);
}

router.get('/prices/:asset_code', async (req, res) => {
  try {
    const { asset_code } = req.params;
    const { issuer } = req.query;

    const normalizedCode = asset_code.toUpperCase();

    if (!validateAssetCode(normalizedCode)) {
      return res.status(400).json({
        error: 'Invalid asset code',
        message: 'Asset code must be 1-12 alphanumeric characters',
      });
    }

    if (!validateIssuer(issuer)) {
      return res.status(400).json({
        error: 'Invalid issuer',
        message: 'Issuer must be a valid Stellar address (G...)',
      });
    }

    const priceData = await priceOracle.getPrice(normalizedCode, issuer || null);

    if (priceData.price_usd === null) {
      return res.status(404).json({
        error: 'Price not available',
        message: `No price data found for ${normalizedCode}`,
        ...priceData,
      });
    }

    return res.json(priceData);
  } catch (err) {
    logger.error('Price endpoint error', { error: err.message, stack: err.stack });
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch price data',
    });
  }
});

router.get('/prices/:asset_code/refresh', requireApiKey(), async (req, res) => {
  try {
    const { asset_code } = req.params;
    const { issuer } = req.query;
    const normalizedCode = asset_code.toUpperCase();

    if (!validateAssetCode(normalizedCode)) {
      return res.status(400).json({
        error: 'Invalid asset code',
        message: 'Asset code must be 1-12 alphanumeric characters',
      });
    }

    if (!validateIssuer(issuer)) {
      return res.status(400).json({
        error: 'Invalid issuer',
        message: 'Issuer must be a valid Stellar address (G...)',
      });
    }

    const priceData = await priceOracle.fetchFreshPrice(normalizedCode, issuer || null);

    return res.json(priceData);
  } catch (err) {
    logger.error('Price refresh endpoint error', { error: err.message, stack: err.stack });
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to refresh price data',
    });
  }
});

module.exports = router;
