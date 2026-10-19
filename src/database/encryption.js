'use strict';

/**
 * Database Encryption at Rest (#519).
 *
 * Implements authenticated field-level AES-256-GCM encryption for sensitive data
 * stored in the database (e.g. credentials, tokens, secrets, PII).
 *
 * Encrypted values are packed as:
 *   enc:v1:<iv_base64>:<ciphertext_base64>:<authTag_base64>
 *
 * Features:
 * - Deterministic prefix allows detecting already-encrypted values (isEncrypted).
 * - Safe decryption transparently leaves legacy plaintext untouched (migration-friendly).
 * - Authenticated cipher (GCM) guarantees tampering detection via 16-byte authTag.
 * - Blind indexing (HMAC-SHA256) enables exact-match lookups without exposing plaintext.
 */

const crypto = require('crypto');
const config = require('../config');
const logger = require('../logger');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // Standard 96-bit IV for GCM
const PREFIX = 'enc:v1:';
const DEV_FALLBACK_KEY_MATERIAL = 'smartdrop-dev-db-encryption-key-do-not-use-in-production';

let warnedAboutDevKey = false;
let cachedDerivedKey = null;

/**
 * Derive 32-byte AES-256 encryption key from configuration.
 *
 * @param {string} [customKeyMaterial] - Optional explicit key override
 * @returns {Buffer} 32-byte key buffer
 */
function deriveKey(customKeyMaterial) {
  if (customKeyMaterial) {
    return crypto.createHash('sha256').update(customKeyMaterial).digest();
  }

  if (cachedDerivedKey) return cachedDerivedKey;

  const configured =
    config.databaseEncryptionKey ||
    config.dbEncryptionKey ||
    process.env.DB_ENCRYPTION_KEY;

  if (!configured) {
    // #533 — DEV_FALLBACK_KEY_MATERIAL is a fixed, public string committed to
    // this repo. Silently encrypting production data with it is equivalent
    // to not encrypting at all, so production must set a real key instead
    // of just being warned.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'DB_ENCRYPTION_KEY must be set in production — refusing to encrypt data at rest ' +
          'with the public fallback development key.'
      );
    }
    if (!warnedAboutDevKey && process.env.NODE_ENV !== 'test') {
      logger.warn(
        'DB_ENCRYPTION_KEY is not set — database encryption is using an insecure fixed development key. ' +
          'Set DB_ENCRYPTION_KEY in production to protect sensitive data at rest.'
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
 * Check if a value is already encrypted with our format.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * Encrypt a plaintext value.
 *
 * @param {*} value - Plaintext string, number, boolean, or object
 * @param {Object} [options]
 * @param {string} [options.key] - Optional custom key
 * @returns {string} Encrypted packed string
 */
function encrypt(value, options = {}) {
  if (value === null || value === undefined) {
    return value;
  }

  // Already encrypted?
  if (isEncrypted(value)) {
    return value;
  }

  // Serialize objects/arrays/numbers/booleans if needed
  let plaintext;
  if (typeof value === 'object') {
    plaintext = JSON.stringify(value);
  } else {
    plaintext = String(value);
  }

  const key = deriveKey(options.key);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString('base64')}:${ciphertext.toString('base64')}:${authTag.toString('base64')}`;
}

/**
 * Decrypt an encrypted value. If the value is not encrypted (e.g. legacy row),
 * returns it as-is.
 *
 * @param {*} packed - Encrypted packed string or legacy value
 * @param {Object} [options]
 * @param {string} [options.key] - Optional custom key
 * @param {boolean} [options.parseJson=false] - Attempt to JSON parse result
 * @returns {*} Decrypted plaintext string (or parsed object)
 */
function decrypt(packed, options = {}) {
  if (packed === null || packed === undefined) {
    return packed;
  }

  if (typeof packed !== 'string' || !packed.startsWith(PREFIX)) {
    return packed; // Legacy unencrypted value
  }

  const payload = packed.slice(PREFIX.length);
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted database value: expected 3 segments (iv:ciphertext:authTag)');
  }

  const [ivB64, ciphertextB64, authTagB64] = parts;
  const key = deriveKey(options.key);
  const iv = Buffer.from(ivB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decryptedBuf = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  const decryptedStr = decryptedBuf.toString('utf8');

  if (options.parseJson) {
    try {
      return JSON.parse(decryptedStr);
    } catch {
      return decryptedStr;
    }
  }

  return decryptedStr;
}

/**
 * Encrypt sensitive fields on a database record/row.
 *
 * @param {Object} row - Database row
 * @param {string[]} fields - Field names to encrypt
 * @param {Object} [options]
 * @returns {Object} Clone of row with encrypted fields
 */
function encryptRecord(row, fields = [], options = {}) {
  if (!row || typeof row !== 'object') return row;
  const result = { ...row };

  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(result, field) && result[field] !== null && result[field] !== undefined) {
      result[field] = encrypt(result[field], options);
    }
  }

  return result;
}

/**
 * Decrypt sensitive fields on a database record/row.
 *
 * @param {Object} row - Database row
 * @param {string[]} [fields] - Field names to decrypt (if omitted, decrypts all fields starting with PREFIX)
 * @param {Object} [options]
 * @returns {Object} Clone of row with decrypted fields
 */
function decryptRecord(row, fields, options = {}) {
  if (!row || typeof row !== 'object') return row;
  const result = { ...row };

  if (Array.isArray(fields) && fields.length > 0) {
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(result, field) && result[field] !== null && result[field] !== undefined) {
        result[field] = decrypt(result[field], options);
      }
    }
  } else {
    // Auto-detect encrypted fields
    for (const key of Object.keys(result)) {
      if (isEncrypted(result[key])) {
        result[key] = decrypt(result[key], options);
      }
    }
  }

  return result;
}

/**
 * Encrypt an array of database rows.
 *
 * @param {Object[]} rows
 * @param {string[]} fields
 * @param {Object} [options]
 * @returns {Object[]}
 */
function encryptRows(rows, fields = [], options = {}) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((r) => encryptRecord(r, fields, options));
}

/**
 * Decrypt an array of database rows.
 *
 * @param {Object[]} rows
 * @param {string[]} [fields]
 * @param {Object} [options]
 * @returns {Object[]}
 */
function decryptRows(rows, fields, options = {}) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((r) => decryptRecord(r, fields, options));
}

/**
 * Create a blind index HMAC-SHA256 for searching encrypted fields.
 *
 * @param {string} value - Plaintext value to hash for exact lookup
 * @param {string} [salt=''] - Optional salt or domain separator
 * @returns {string} 64-character hex digest
 */
function hashBlindIndex(value, salt = '') {
  if (value === null || value === undefined) return null;
  const key = deriveKey();
  const normalized = String(value).trim().toLowerCase();
  return crypto.createHmac('sha256', key).update(`${salt}:${normalized}`).digest('hex');
}

/**
 * Reset cached key (useful for testing with different keys).
 */
function _resetCachedKey() {
  cachedDerivedKey = null;
  warnedAboutDevKey = false;
}

module.exports = {
  encrypt,
  decrypt,
  isEncrypted,
  encryptRecord,
  decryptRecord,
  encryptRow: encryptRecord,
  decryptRow: decryptRecord,
  encryptFields: encryptRecord,
  decryptFields: decryptRecord,
  encryptRows,
  decryptRows,
  hashBlindIndex,
  deriveKey,
  _resetCachedKey,
};
