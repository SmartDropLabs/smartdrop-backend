const express = require('express');
const config = require('../config');
const { requireApiKey } = require('../middleware/auth');
const buildRateLimit = require('../middleware/rateLimit');
const priceOracle = require('../services/priceOracle');
const AppError = require('../errors/AppError');

const router = express.Router();

const priceLimit = buildRateLimit({
  windowSeconds: config.priceRateLimit.windowSeconds,
  max: config.priceRateLimit.max,
  keyPrefix: 'prices',
});

router.use(priceLimit);

function validateAssetCode(assetCode) {
  if (!assetCode || typeof assetCode !== 'string') return false;
  if (assetCode.length < 1 || assetCode.length > 12) return false;
  return /^[A-Z0-9]+$/.test(assetCode);
}

function validateIssuer(issuer) {
  if (!issuer) return true;
  return /^G[A-Z0-9]{55}$/.test(issuer);
}

function validatePriceRequest(assetCode, issuer) {
  if (!validateAssetCode(assetCode)) {
    throw new AppError('VALIDATION_ERROR', 'Asset code must be 1-12 uppercase alphanumeric characters', 400, {
      field: 'assetCode',
      received: assetCode,
      constraint: 'regex',
    });
  }

  if (!validateIssuer(issuer)) {
    throw new AppError('VALIDATION_ERROR', 'Issuer must be a valid Stellar address (G...)', 400, {
      field: 'issuer',
      received: issuer,
      constraint: 'stellar_public_key',
    });
  }
}

router.get('/prices/:asset_code', async (req, res, next) => {
  try {
    const { asset_code } = req.params;
    const { issuer } = req.query;
    const normalizedCode = asset_code.toUpperCase();
    validatePriceRequest(normalizedCode, issuer);

    const priceData = await priceOracle.getPrice(normalizedCode, issuer || null);

    if (priceData.price_usd === null) {
      throw new AppError('NOT_FOUND', `No price data found for ${normalizedCode}`, 404, { asset_code: normalizedCode, issuer: issuer || null });
    }

    return res.json(priceData);
  } catch (err) {
    return next(err);
  }
});

router.get('/prices/:asset_code/refresh', requireApiKey(), async (req, res, next) => {
  try {
    const { asset_code } = req.params;
    const { issuer } = req.query;
    const normalizedCode = asset_code.toUpperCase();
    validatePriceRequest(normalizedCode, issuer);

    const priceData = await priceOracle.fetchFreshPrice(normalizedCode, issuer || null);
    if (priceData.price_usd === null) {
      throw new AppError('UPSTREAM_ERROR', 'All price sources failed', 502, { asset_code: normalizedCode, issuer: issuer || null });
    }
    return res.json(priceData);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
