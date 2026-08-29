'use strict';

/**
 * AES-256-GCM encryption for webhook secrets at rest (issue #145).
 *
 * Unlike API keys (hashed one-way — see apiKeys.js), a webhook secret must be
 * recovered in plaintext at delivery time to compute the outbound HMAC
 * signature (webhookDispatcher.js / webhookSignature.js), so it's encrypted
 * — reversible with the master key — rather than hashed.
 *
 * The master key comes from `WEBHOOK_SECRET_ENCRYPTION_KEY` (any string —
 * passphrase, hex, or base64; SHA-256 always reduces it to exactly 32
 * bytes). Left unset, a fixed development key is used and a warning is
 * logged once; production deployments must set a real key.
 */

const crypto = require('crypto');
const config = require('../config');
const logger = require('../logger');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const DEV_FALLBACK_KEY_MATERIAL = 'smartdrop-dev-insecure-webhook-key-do-not-use-in-production';

let warnedAboutDevKey = false;

function deriveKey() {
  const configured = config.webhookSecretEncryptionKey;
  if (!configured) {
    if (!warnedAboutDevKey) {
      logger.warn(
        'WEBHOOK_SECRET_ENCRYPTION_KEY is not set — webhook secrets are encrypted with an ' +
          'insecure fixed development key. Set WEBHOOK_SECRET_ENCRYPTION_KEY in production.',
      );
      warnedAboutDevKey = true;
    }
    return crypto.createHash('sha256').update(DEV_FALLBACK_KEY_MATERIAL).digest();
  }
  return crypto.createHash('sha256').update(configured).digest();
}

/**
 * Encrypts `plaintext`. Returns `<iv>.<ciphertext>.<authTag>`, each
 * base64-encoded — a format chosen to visually distinguish encrypted values
 * from legacy plaintext `whsec_...` secrets (see {@link isEncrypted}).
 */
function encryptSecret(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('webhook secret to encrypt must be a non-empty string');
  }
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), ciphertext.toString('base64'), authTag.toString('base64')].join('.');
}

/**
 * Decrypts a value produced by {@link encryptSecret}.
 * @throws if the payload is malformed, or the auth tag doesn't verify
 *   (wrong key or corrupted/tampered ciphertext).
 */
function decryptSecret(packed) {
  if (typeof packed !== 'string') {
    throw new Error('encrypted webhook secret must be a string');
  }
  const parts = packed.split('.');
  if (parts.length !== 3) {
    throw new Error('malformed encrypted webhook secret');
  }
  const [ivB64, ciphertextB64, authTagB64] = parts;
  const key = deriveKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

/**
 * Distinguishes an {@link encryptSecret} payload (three base64 segments
 * joined by `.`) from a legacy plaintext secret (`whsec_...`, no `.`), so
 * `webhookRepository` can transparently read records written before this
 * encryption was introduced.
 */
function isEncrypted(value) {
  return typeof value === 'string' && !value.startsWith('whsec_') && value.split('.').length === 3;
}

module.exports = { encryptSecret, decryptSecret, isEncrypted };
