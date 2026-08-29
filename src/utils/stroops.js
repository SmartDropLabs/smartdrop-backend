'use strict';

const STROOPS_PER_UNIT = 10_000_000n;
const MAX_DECIMALS = 7;

/**
 * Convert a decimal amount (e.g. 1.5) to integer stroops using BigInt.
 * Throws on NaN, Infinity, negative values, or exceeding 7 decimal places.
 */
function toStroops(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    throw new Error('amount must be a non-negative finite number');
  }

  // Convert to fixed-point string to avoid scientific notation (e.g. 1e-7)
  // and to get a predictable decimal representation.
  const fixed = amount.toFixed(MAX_DECIMALS);

  // Verify no precision loss: the fixed string must round-trip to the same value.
  if (Number(fixed) !== amount) {
    throw new Error(`amount must have at most ${MAX_DECIMALS} decimal places`);
  }

  // fixed is always "XXXXXXXX.XXXXXXX" (7 decimal places, zero-padded)
  const withoutDot = fixed.replace('.', '');
  return BigInt(withoutDot);
}

/**
 * Sum an array of recipient amounts as stroops.
 */
function sumStroops(recipients) {
  let total = 0n;
  for (const r of recipients) {
    total += toStroops(r.amount);
  }
  return total;
}

/**
 * Compare two decimal amounts in stroops for equality.
 */
function stroopsEqual(a, b) {
  return toStroops(a) === toStroops(b);
}

module.exports = { toStroops, sumStroops, stroopsEqual, STROOPS_PER_UNIT, MAX_DECIMALS };
