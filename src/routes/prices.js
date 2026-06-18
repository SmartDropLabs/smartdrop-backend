const express = require('express');
const priceOracle = require('../services/priceOracle');
const logger = require('../logger');

const router = express.Router();

router.get('/prices/:asset_code', async (req, res) => {
  try {
    const { asset_code } = req.params;
    const { issuer } = req.query;

    if (!asset_code || asset_code.length > 12) {
      return res.status(400).json({
        error: 'Invalid asset code',
        message: 'Asset code must be 1-12 characters',
      });
    }

    const normalizedCode = asset_code.toUpperCase();

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

router.get('/prices/:asset_code/refresh', async (req, res) => {
  try {
    const { asset_code } = req.params;
    const { issuer } = req.query;
    const normalizedCode = asset_code.toUpperCase();

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
