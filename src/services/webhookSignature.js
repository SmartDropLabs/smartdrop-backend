'use strict';

const crypto = require('crypto');

/**
 * Signature scheme versions (#695).
 *
 * The header starts with the scheme version, so the algorithm can change later without breaking receivers:
 *   v1=<hex>; t=<timestamp>; n=<nonce>      current: HMAC-SHA256 over `<t>.<n>.<body>`
 *   sha256=<hex>; t=<timestamp>; n=<nonce>  legacy: same HMAC, still accepted by verifiers
 * An unknown version is rejected with `unsupported_version`, so a future scheme fails loudly, not as a mismatch.
 */
const SIGNATURE_VERSION = 'v1';
const SIGNATURE_PREFIX = `${SIGNATURE_VERSION}=`;
const LEGACY_SIGNATURE_PREFIX = 'sha256=';
// Version -> HMAC algorithm. Add a new entry here when the scheme changes.
const ALGORITHMS = { v1: 'sha256', sha256: 'sha256' };

function bodyString(body) {
  return typeof body === 'string' ? body : JSON.stringify(body);
}

/**
 * Sign a webhook payload with timestamp and nonce to prevent replay attacks.
 *
 * The signed payload is `<timestamp>.<nonce>.<body>`. The header is
 * `v1=<hex>; t=<timestamp>; n=<nonce>`.
 */
function sign(secret, body) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('signature secret must be a non-empty string');
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = `${timestamp}.${nonce}.${bodyString(body)}`;
  const digest = crypto.createHmac(ALGORITHMS[SIGNATURE_VERSION], secret).update(payload).digest('hex');
  return `${SIGNATURE_PREFIX}${digest}; t=${timestamp}; n=${nonce}`;
}

/**
 * Parse `<version>=<hex>; t=<timestamp>; n=<nonce>`. Returns null when the header has no version.
 */
function parseSignatureHeader(header) {
  const [head, ...fields] = header.split('; ');
  const eq = head.indexOf('=');
  if (eq < 1) return null;
  const parsed = { version: head.slice(0, eq), digest: head.slice(eq + 1), timestamp: null, nonce: null };
  for (const field of fields) {
    const i = field.indexOf('=');
    if (i < 1) continue;
    const key = field.slice(0, i);
    const value = field.slice(i + 1);
    if (key === 't') parsed.timestamp = Number(value);
    else if (key === 'n') parsed.nonce = value;
  }
  return parsed;
}

/**
 * Verify a webhook signature, rejecting replays older than maxAgeSeconds.
 *
 * Returns a boolean for backward compatibility; use `verifyDetailed()` when you need the rejection reason.
 */
function verify(secret, body, providedSignature, { maxAgeSeconds = 300 } = {}) {
  return verifyDetailed(secret, body, providedSignature, { maxAgeSeconds }).valid;
}

/**
 * Like `verify()` but returns { valid, reason } so callers can distinguish
 * "bad signature", "expired replay" and "unsupported version" for logging.
 */
function verifyDetailed(secret, body, providedSignature, { maxAgeSeconds = 300 } = {}) {
  if (typeof providedSignature !== 'string') {
    return { valid: false, reason: 'invalid_format' };
  }
  const parsed = parseSignatureHeader(providedSignature);
  if (!parsed) {
    return { valid: false, reason: 'invalid_format' };
  }
  const algorithm = ALGORITHMS[parsed.version];
  if (!algorithm) {
    return { valid: false, reason: 'unsupported_version' };
  }
  if (!parsed.digest || !parsed.timestamp || !parsed.nonce) {
    return { valid: false, reason: 'missing_fields' };
  }

  // Reject if timestamp is too old (replay window).
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > maxAgeSeconds) {
    return { valid: false, reason: 'expired' };
  }

  let expectedDigest;
  try {
    const payload = `${parsed.timestamp}.${parsed.nonce}.${bodyString(body)}`;
    expectedDigest = crypto.createHmac(algorithm, secret).update(payload).digest('hex');
  } catch {
    return { valid: false, reason: 'signing_error' };
  }

  const a = Buffer.from(expectedDigest, 'hex');
  const b = Buffer.from(parsed.digest, 'hex');
  if (a.length !== b.length) return { valid: false, reason: 'mismatch' };
  if (!crypto.timingSafeEqual(a, b)) return { valid: false, reason: 'mismatch' };

  return { valid: true, reason: null };
}

function generateSecret(bytes = 32) {
  return `whsec_${crypto.randomBytes(bytes).toString('hex')}`;
}

/**
 * Validate that a timestamp is within the acceptable age window (#639).
 *
 * @param {number|string} timestamp - Timestamp in seconds or milliseconds
 * @param {number} [maxAgeSeconds=300] - Tolerance window (default: 5 minutes)
 * @returns {boolean} True if within tolerance
 */
function isTimestampValid(timestamp, maxAgeSeconds = 300) {
  if (!timestamp) return false;
  const num = Number(timestamp);
  if (isNaN(num) || num <= 0) return false;
  const tsSeconds = num > 1e11 ? Math.floor(num / 1000) : num;
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - tsSeconds) <= maxAgeSeconds;
}

/**
 * Generate signature with explicit timestamp for replay attack protection (#639).
 *
 * Format: `t=${timestamp},v1=${hmac}`
 *
 * @param {string} secret
 * @param {string|Object} body
 * @param {number} [timestamp=Date.now()]
 * @returns {string} Signed timestamp token
 */
function signWithTimestamp(secret, body, timestamp = Date.now()) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('signature secret must be a non-empty string');
  }
  const num = Number(timestamp);
  const tsSeconds = num > 1e11 ? Math.floor(num / 1000) : num;
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const hmac = crypto.createHmac('sha256', secret).update(`${tsSeconds}.${bodyStr}`).digest('hex');
  return `t=${tsSeconds},v1=${hmac}`;
}

/**
 * Verify signature with timestamp replay check (#639).
 *
 * @param {string} secret
 * @param {string|Object} body
 * @param {string} signatureWithTimestamp
 * @param {number} [maxAgeSeconds=300]
 * @returns {boolean}
 */
function verifyWithTimestamp(secret, body, signatureWithTimestamp, maxAgeSeconds = 300) {
  if (!signatureWithTimestamp || typeof signatureWithTimestamp !== 'string') return false;
  const match = signatureWithTimestamp.match(/t=(\d+)[,;]\s*(?:v1=|sha256=)?([0-9a-f]+)/i);
  if (!match) return false;

  const [, tsStr, digest] = match;
  const timestamp = Number(tsStr);
  if (!isTimestampValid(timestamp, maxAgeSeconds)) return false;

  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${bodyStr}`).digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(digest, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  sign,
  verify,
  verifyDetailed,
  generateSecret,
  SIGNATURE_PREFIX,
  SIGNATURE_VERSION,
  LEGACY_SIGNATURE_PREFIX,
  isTimestampValid,
  signWithTimestamp,
  verifyWithTimestamp,
};
