'use strict';

const crypto = require('crypto');
const config = require('../config');

const SIGNATURE_PREFIX = 'sha256=';

// Bumped from the unversioned v1 scheme (HMAC over the raw body alone) to v2
// (HMAC over `${timestamp}.${body}`) by #97. v1 signatures carried nothing
// that expired, so a captured delivery stayed replayable forever. Sent on
// every delivery so subscribers can tell the two apart on the wire.
const SIGNATURE_VERSION = '2';

const SIGNATURE_HEADER = 'X-SmartDrop-Signature';
const TIMESTAMP_HEADER = 'X-SmartDrop-Timestamp';
const VERSION_HEADER = 'X-SmartDrop-Signature-Version';

function payloadBody(body) {
  return typeof body === 'string' ? body : JSON.stringify(body);
}

/**
 * Parses a timestamp that arrived over the wire (so: almost certainly a
 * string) into epoch milliseconds, or null when it is not a usable value.
 *
 * Deliberately stricter than `Number()`, which coerces a surprising number
 * of junk values into something that looks like a valid instant:
 * `Number('') === 0`, `Number([]) === 0`, `Number(null) === 0`, and
 * `Number(true) === 1`. Each of those would sail through a plain
 * `Number.isNaN` guard and then be compared against the replay window as if
 * it were 1970, so they must be rejected by shape rather than by value.
 */
function parseTimestamp(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const digits = String(value).trim();
  // Digits only: rejects '', 'abc', '-1', '12.5', '1e3' and '0x10'.
  if (!/^\d+$/.test(digits)) return null;
  const millis = Number(digits);
  return Number.isSafeInteger(millis) ? millis : null;
}

/**
 * Signs `body` for delivery at `timestamp`, returning the value of the
 * X-SmartDrop-Signature header.
 *
 * The timestamp is inside the MAC, not merely alongside it: a captured
 * delivery cannot be re-dated without invalidating the signature, which is
 * what makes the replay window on the verify side meaningful.
 */
function sign(secret, body, timestamp = Date.now()) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('signature secret must be a non-empty string');
  }
  const signedAt = parseTimestamp(timestamp);
  if (signedAt === null) {
    throw new Error('signature timestamp must be epoch milliseconds');
  }
  const digest = crypto
    .createHmac('sha256', secret)
    .update(`${signedAt}.${payloadBody(body)}`)
    .digest('hex');
  return `${SIGNATURE_PREFIX}${digest}`;
}

/**
 * Verifies a delivery signature against the timestamp it was signed with.
 *
 * Returns false rather than throwing for every rejection reason, so callers
 * can treat it as a plain predicate. Rejects when:
 *   - the timestamp header is missing or not epoch milliseconds;
 *   - the timestamp is outside the replay window, measured symmetrically:
 *     a future-dated timestamp is as invalid as a stale one, otherwise an
 *     attacker could hand us a timestamp years ahead and hold a signature
 *     that never expires;
 *   - the recomputed MAC does not match, compared in constant time.
 */
function verify(secret, body, signatureHeader, timestampHeader, options = {}) {
  const maxAgeSeconds = options.maxAgeSeconds ?? config.webhooks.signatureMaxAgeSeconds;

  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }

  const signedAt = parseTimestamp(timestampHeader);
  if (signedAt === null) return false;
  if (Math.abs(Date.now() - signedAt) > maxAgeSeconds * 1000) return false;

  let expected;
  try {
    expected = sign(secret, body, signedAt);
  } catch {
    return false;
  }

  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Builds the three signature headers that every outgoing delivery carries.
 *
 * Resolving the timestamp once here — rather than letting the caller sign
 * with one value and stamp the header from another — is what keeps the
 * header and the MAC from ever drifting apart. Callers that need extra
 * headers (event type, delivery id, …) spread this into their own set so
 * there is exactly one place the signing scheme is defined.
 */
function signatureHeaders(secret, body, timestamp = Date.now()) {
  const signedAt = parseTimestamp(timestamp);
  if (signedAt === null) {
    throw new Error('signature timestamp must be epoch milliseconds');
  }
  return {
    [SIGNATURE_HEADER]: sign(secret, body, signedAt),
    [TIMESTAMP_HEADER]: String(signedAt),
    [VERSION_HEADER]: SIGNATURE_VERSION,
  };
}

function generateSecret(bytes = 32) {
  return `whsec_${crypto.randomBytes(bytes).toString('hex')}`;
}

module.exports = {
  sign,
  verify,
  signatureHeaders,
  generateSecret,
  SIGNATURE_PREFIX,
  SIGNATURE_VERSION,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  VERSION_HEADER,
};
