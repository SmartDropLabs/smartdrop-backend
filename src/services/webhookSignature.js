'use strict';

const crypto = require('crypto');

const SIGNATURE_PREFIX = 'sha256=';

/**
 * Sign a webhook payload with timestamp and nonce to prevent replay attacks.
 *
 * The signed payload format is: `<timestamp>.<nonce>.<body>`
 * - `timestamp`: Unix epoch seconds when the signature was created
 * - `nonce`: random per-delivery string ensuring each signature is unique
 * - `body`: the JSON payload
 *
 * The signature header includes the timestamp and nonce as metadata:
 * `sha256=<hex>; t=<timestamp>; n=<nonce>`
 */
function sign(secret, body) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('signature secret must be a non-empty string');
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const payload = `${timestamp}.${nonce}.${bodyStr}`;
  const digest = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${SIGNATURE_PREFIX}${digest}; t=${timestamp}; n=${nonce}`;
}

/**
 * Verify a webhook signature, rejecting replays older than maxAgeSeconds.
 *
 * Parses the signature header to extract the digest, timestamp, and nonce,
 * then recomputes the HMAC over the original payload and compares in
 * constant time. Returns a boolean for backward compatibility; use
 * `verifyDetailed()` when you need the rejection reason.
 */
function verify(secret, body, providedSignature, { maxAgeSeconds = 300 } = {}) {
  return verifyDetailed(secret, body, providedSignature, { maxAgeSeconds }).valid;
}

/**
 * Like `verify()` but returns { valid, reason } so callers can distinguish
 * between "bad signature" and "expired replay" for logging.
 */
function verifyDetailed(secret, body, providedSignature, { maxAgeSeconds = 300 } = {}) {
  if (typeof providedSignature !== 'string' || !providedSignature.startsWith(SIGNATURE_PREFIX)) {
    return { valid: false, reason: 'invalid_format' };
  }

  // Parse: "sha256=<hex>; t=<timestamp>; n=<nonce>"
  const parts = providedSignature.slice(SIGNATURE_PREFIX.length).split('; ').reduce((acc, part) => {
    const [k, v] = part.split('=');
    if (k === 't') acc.timestamp = Number(v);
    else if (k === 'n') acc.nonce = v;
    else if (!acc.digest) acc.digest = part;
    return acc;
  }, { digest: null, timestamp: null, nonce: null });

  if (!parts.digest || !parts.timestamp || !parts.nonce) {
    return { valid: false, reason: 'missing_fields' };
  }

  // Reject if timestamp is too old (replay window).
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parts.timestamp) > maxAgeSeconds) {
    return { valid: false, reason: 'expired' };
  }

  let expectedDigest;
  try {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const payload = `${parts.timestamp}.${parts.nonce}.${bodyStr}`;
    expectedDigest = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  } catch {
    return { valid: false, reason: 'signing_error' };
  }

  const a = Buffer.from(expectedDigest, 'hex');
  const b = Buffer.from(parts.digest, 'hex');
  if (a.length !== b.length) return { valid: false, reason: 'mismatch' };
  if (!crypto.timingSafeEqual(a, b)) return { valid: false, reason: 'mismatch' };

  return { valid: true, reason: null };
}

function generateSecret(bytes = 32) {
  return `whsec_${crypto.randomBytes(bytes).toString('hex')}`;
}

module.exports = { sign, verify, verifyDetailed, generateSecret, SIGNATURE_PREFIX };
