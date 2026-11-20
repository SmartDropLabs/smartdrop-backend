'use strict';

const AppError = require('../errors/AppError');

// Upper bound for a single USD price. Same cap as MAX_ALERT_THRESHOLD_USD in
// schemas.js, so no accepted price can exceed what an alert can be set against.
const MAX_PRICE_USD = 1e12;

function isValidPriceUsd(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_PRICE_USD;
}

/**
 * Rejects a price payload whose price_usd is not a finite, non-negative number
 * within MAX_PRICE_USD (#670). A null price means "no data" and is passed
 * through so the caller can apply its own 404/502 handling.
 */
function assertValidPriceData(priceData) {
  if (!priceData || priceData.price_usd === null) return priceData;
  if (!isValidPriceUsd(priceData.price_usd)) {
    throw new AppError('VALIDATION', 'Invalid price', 400, {
      asset_code: priceData.asset_code ?? null,
      issuer: priceData.issuer ?? null,
    });
  }
  return priceData;
}

module.exports = { MAX_PRICE_USD, isValidPriceUsd, assertValidPriceData };
