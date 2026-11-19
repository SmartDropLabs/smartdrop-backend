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
let cachedDerivedKey = null;

function deriveKey() {
  if (cachedDerivedKey) return cachedDerivedKey;

  const configured = config.webhookSecretEncryptionKey;
  if (!configured) {
    if (!warnedAboutDevKey) {
      logger.warn(
        'WEBHOOK_SECRET_ENCRYPTION_KEY is not set — webhook secrets are encrypted with an ' +
          'insecure fixed development key. Set WEBHOOK_SECRET_ENCRYPTION_KEY in production.',
      );
      warnedAboutDevKey = true;
    }
    cachedDerivedKey = crypto.createHash('sha256').update(DEV_FALLBACK_KEY_MATERIAL).digest();
  } else {
    cachedDerivedKey = crypto.createHash('sha256').update(configured).digest();
  }
  return cachedDerivedKey;
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

/**
 * Encrypts a webhook payload with AES-256-GCM, keyed from the webhook secret. The receiver decrypts with the same
 * secret (issue #572).
 *
 * The output is a JSON envelope that carries its own metadata (#696):
 *   {"v":1,"alg":"aes-256-gcm","iv":"<b64>","data":"<b64>","tag":"<b64>"}
 * so receivers know the format and algorithm without guessing. Payloads in the older `<iv>.<ciphertext>.<tag>`
 * form are still accepted by decryptPayload.
 */
const PAYLOAD_ENVELOPE_VERSION = 1;

function payloadKey(webhookSecret) {
  return crypto.createHash('sha256').update(webhookSecret).digest();
}

function encryptPayload(plaintext, webhookSecret) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('webhook payload to encrypt must be a non-empty string');
  }
  if (typeof webhookSecret !== 'string' || webhookSecret.length === 0) {
    throw new Error('webhook secret must be a non-empty string');
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, payloadKey(webhookSecret), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: PAYLOAD_ENVELOPE_VERSION,
    alg: ALGORITHM,
    iv: iv.toString('base64'),
    data: data.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  });
}

/** Returns the parsed envelope, null when the value is not JSON, or throws for an unknown version or algorithm. */
function parseEnvelope(packed) {
  let envelope;
  try {
    envelope = JSON.parse(packed);
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== 'object') return null;
  if (envelope.v !== PAYLOAD_ENVELOPE_VERSION) {
    throw new Error('unsupported encrypted webhook payload version');
  }
  if (envelope.alg !== ALGORITHM) {
    throw new Error('unsupported encrypted webhook payload algorithm');
  }
  return envelope;
}

/**
 * Decrypts a webhook payload encrypted with {@link encryptPayload}, or a legacy `<iv>.<ciphertext>.<tag>` value.
 * @throws if the payload is malformed, uses an unknown version, or the auth tag doesn't verify.
 */
function decryptPayload(packed, webhookSecret) {
  if (typeof packed !== 'string') {
    throw new Error('encrypted webhook payload must be a string');
  }
  if (typeof webhookSecret !== 'string' || webhookSecret.length === 0) {
    throw new Error('webhook secret must be a non-empty string');
  }
  let ivB64;
  let dataB64;
  let tagB64;
  const envelope = packed.trimStart().startsWith('{') ? parseEnvelope(packed) : null;
  if (envelope) {
    ({ iv: ivB64, data: dataB64, tag: tagB64 } = envelope);
  } else {
    const parts = packed.split('.');
    if (parts.length !== 3) {
      throw new Error('malformed encrypted webhook payload');
    }
    [ivB64, dataB64, tagB64] = parts;
  }
  if (typeof ivB64 !== 'string' || typeof dataB64 !== 'string' || typeof tagB64 !== 'string') {
    throw new Error('malformed encrypted webhook payload');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, payloadKey(webhookSecret), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return plaintext.toString('utf8');
}

function isEnvelope(value) {
  try {
    const envelope = JSON.parse(value);
    return !!envelope && envelope.v === PAYLOAD_ENVELOPE_VERSION && envelope.alg === ALGORITHM;
  } catch {
    return false;
  }
}

/**
 * Checks if a value is an encrypted payload: a v1 envelope, or a legacy three-part value.
 */
function isPayloadEncrypted(value) {
  return typeof value === 'string' && (isEnvelope(value) || value.split('.').length === 3);
}

// ── Key Rotation (#629) ──────────────────────────────────────────────────

const inMemoryKeyStore = new Map();

const keyStore = {
  async save(keyId, key, metadata = {}) {
    const record = { key, ...metadata };
    inMemoryKeyStore.set(keyId, record);
    return record;
  },
  async get(keyId) {
    return inMemoryKeyStore.get(keyId) || null;
  },
  async delete(keyId) {
    return inMemoryKeyStore.delete(keyId);
  },
};

function generateKey() {
  return crypto.randomBytes(32).toString('hex');
}

async function rotateKey(keyId) {
  const newKey = generateKey();
  const version = Date.now();
  await keyStore.save(keyId, newKey, { version });
  return { keyId, key: newKey, version };
}

async function getKey(keyId) {
  return await keyStore.get(keyId);
}

module.exports = {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  encryptPayload,
  decryptPayload,
  isPayloadEncrypted,
  generateKey,
  rotateKey,
  getKey,
  keyStore,
};
