const express = require('express');
const config = require('../config');
const { requireApiKey } = require('../middleware/auth');
const { routeTimeout } = require('../middleware/timeout');
const { validate } = require('../middleware/validate');
const buildRateLimit = require('../middleware/rateLimit');
const priceOracle = require('../services/priceOracle');
const AppError = require('../errors/AppError');
const { priceParamsSchema, priceQuerySchema } = require('../validation/schemas');

const router = express.Router();

const validatePriceParams = validate(priceParamsSchema, 'params');
const validatePriceQuery = validate(priceQuerySchema, 'query');
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

router.get('/prices/:asset_code', validatePriceParams, validatePriceQuery, async (req, res, next) => {
  try {
    const { asset_code: normalizedCode } = req.validated.params;
    const { issuer } = req.query;

    const priceData = await priceOracle.getPrice(normalizedCode, issuer || null);

    if (priceData.price_usd === null) {
      throw new AppError('NOT_FOUND', `No price data found for ${normalizedCode}`, 404, { asset_code: normalizedCode, issuer: issuer || null });
    }

    return res.json(priceData);
  } catch (err) {
    return next(err);
  }
});

router.get('/prices/:asset_code/refresh', routeTimeout(), requireApiKey(), validatePriceParams, validatePriceQuery, async (req, res, next) => {
  try {
    const { asset_code: normalizedCode } = req.validated.params;
    const { issuer } = req.query;

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
