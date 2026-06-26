'use strict';

const crypto = require('crypto');

const SIGNATURE_PREFIX = 'sha256=';

function sign(secret, body) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('signature secret must be a non-empty string');
  }
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const digest = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${SIGNATURE_PREFIX}${digest}`;
}

function verify(secret, body, providedSignature) {
  if (typeof providedSignature !== 'string' || !providedSignature.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }
  let expected;
  try {
    expected = sign(secret, body);
  } catch {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(providedSignature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function generateSecret(bytes = 32) {
  return `whsec_${crypto.randomBytes(bytes).toString('hex')}`;
}

module.exports = { sign, verify, generateSecret, SIGNATURE_PREFIX };
