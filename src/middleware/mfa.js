'use strict';

/**
 * Multi-factor authentication support (#526).
 *
 * Provides TOTP-based MFA for account security. Integrates with the
 * existing auth middleware to require a second factor for sensitive
 * operations.
 */

const crypto = require('crypto');

const MFA_ISSUER = process.env.MFA_ISSUER || 'SmartDrop';
const MFA_WINDOW = 1; // Allow 1 time step (30s) of drift

/**
 * Generate a TOTP secret for a user.
 * Returns a base32-encoded secret.
 */
function generateTotpSecret() {
  return crypto.randomBytes(20).toString('base32');
}

/**
 * Generate a TOTP code from a secret and timestamp.
 * Standard RFC 6238 TOTP implementation.
 */
function generateTotp(secret, timestamp = Date.now()) {
  const timeStep = 30; // 30 seconds
  const counter = Math.floor(timestamp / 1000 / timeStep);

  // Decode base32 secret
  const key = Buffer.from(secret, 'base32');

  // Create HMAC-SHA1
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest();

  // Dynamic truncation
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  ) % 1000000;

  return code.toString().padStart(6, '0');
}

/**
 * Verify a TOTP code against a secret.
 * Checks current time step and ±1 step for clock drift.
 */
function verifyTotp(secret, code, timestamp = Date.now()) {
  if (!code || code.length !== 6) return false;

  for (let i = -MFA_WINDOW; i <= MFA_WINDOW; i++) {
    const expected = generateTotp(secret, timestamp + i * 30 * 1000);
    if (crypto.timingSafeEqual(Buffer.from(code), Buffer.from(expected))) {
      return true;
    }
  }
  return false;
}

/**
 * Generate an otpauth:// URI for QR code display.
 */
function generateOtpauthUri(secret, accountName) {
  return `otpauth://totp/${encodeURIComponent(MFA_ISSUER)}:${encodeURIComponent(accountName)}?secret=${secret}&issuer=${encodeURIComponent(MFA_ISSUER)}`;
}

// Trusted device storage (#703): userId -> Map<sha256(deviceToken), expiresAtMs>
// NOTE: For production with multiple instances, use Redis or another shared store
const trustedDevices = new Map();
const TRUSTED_DEVICE_TTL_MS =
  (parseInt(process.env.MFA_TRUSTED_DEVICE_TTL_DAYS, 10) || 30) * 24 * 60 * 60 * 1000;

function hashDeviceToken(deviceToken) {
  return crypto.createHash('sha256').update(String(deviceToken)).digest('hex');
}

/**
 * Mark a device as trusted for a user (#703).
 * The device token is generated server-side so it can't be guessed or
 * chosen by a client; only its hash is stored.
 * @param {string} userId
 * @param {Object} [options]
 * @param {number} [options.ttlMs] - How long the device stays trusted
 * @returns {string} Opaque device token to hand back to the client
 */
function trustDevice(userId, { ttlMs = TRUSTED_DEVICE_TTL_MS } = {}) {
  if (!userId) throw new Error('trustDevice: userId is required');
  const deviceToken = crypto.randomBytes(32).toString('hex');
  if (!trustedDevices.has(userId)) trustedDevices.set(userId, new Map());
  trustedDevices.get(userId).set(hashDeviceToken(deviceToken), Date.now() + ttlMs);
  return deviceToken;
}

/**
 * Check whether a device token is trusted for a user (#703).
 * Expired entries are removed on lookup.
 * @param {string} userId
 * @param {string} deviceToken
 * @returns {boolean}
 */
function isTrustedDevice(userId, deviceToken) {
  if (!userId || !deviceToken) return false;
  const devices = trustedDevices.get(userId);
  if (!devices) return false;
  const hash = hashDeviceToken(deviceToken);
  const expiresAt = devices.get(hash);
  if (!expiresAt) return false;
  if (Date.now() >= expiresAt) {
    devices.delete(hash);
    if (devices.size === 0) trustedDevices.delete(userId);
    return false;
  }
  return true;
}

/**
 * Revoke trust for one device, or every device when deviceToken is omitted (#703).
 * @param {string} userId
 * @param {string} [deviceToken]
 */
function revokeTrustedDevice(userId, deviceToken) {
  if (!userId) return;
  if (!deviceToken) {
    trustedDevices.delete(userId);
    return;
  }
  const devices = trustedDevices.get(userId);
  if (!devices) return;
  devices.delete(hashDeviceToken(deviceToken));
  if (devices.size === 0) trustedDevices.delete(userId);
}

/**
 * Middleware that requires MFA verification for sensitive operations.
 * Expects X-MFA-Token header with the current TOTP code.
 *
 * Trusted devices (#703): a request carrying a valid X-MFA-Device-Token for
 * the authenticated user skips the TOTP check. Sending
 * X-MFA-Remember-Device: true (or body.rememberDevice) alongside a valid
 * TOTP code trusts the device and returns a new token in the
 * X-MFA-Device-Token response header.
 */
function requireMfa(userSecret) {
  return (req, res, next) => {
    const userId = req.user?.id || req.user?.userId || req.jwt?.sub;
    const deviceToken = req.headers['x-mfa-device-token'];

    if (isTrustedDevice(userId, deviceToken)) {
      return next(); // Skip MFA
    }

    const mfaToken = req.headers['x-mfa-token'] || req.body?.mfaToken;

    if (!mfaToken) {
      return res.status(401).json({
        error: 'MFA required',
        message: 'Multi-factor authentication token is required for this operation.',
      });
    }

    if (!userSecret) {
      return res.status(500).json({
        error: 'MFA not configured',
        message: 'MFA is not configured for this account.',
      });
    }

    if (!verifyTotp(userSecret, mfaToken)) {
      return res.status(401).json({
        error: 'Invalid MFA token',
        message: 'The provided MFA token is invalid or expired.',
      });
    }

    const rememberDevice =
      String(req.headers['x-mfa-remember-device']).toLowerCase() === 'true' ||
      req.body?.rememberDevice === true;
    if (rememberDevice && userId) {
      res.setHeader('X-MFA-Device-Token', trustDevice(userId));
    }

    next();
  };
}

// In-memory or database backup code storage (#649)
const userBackupCodes = new Map();

/**
 * Generate a set of random backup codes for a user (#649).
 * @param {string} userId
 * @param {number} [count=10]
 * @returns {string[]}
 */
function generateBackupCodes(userId, count = 10) {
  const codes = [];
  const codeSet = new Set();
  for (let i = 0; i < count; i++) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(code);
    codeSet.add(code);
  }
  userBackupCodes.set(userId, codeSet);
  return codes;
}

/**
 * Validate and consume a single-use backup code (#649).
 * @param {string} userId
 * @param {string} code
 * @returns {Promise<boolean>}
 */
async function useBackupCode(userId, code) {
  if (!userId || !code) return false;
  const normalized = code.trim().toUpperCase();
  const codes = userBackupCodes.get(userId);
  if (!codes || !codes.has(normalized)) {
    const error = new Error('Invalid or already used backup code');
    error.statusCode = 401;
    error.code = 'UNAUTHORIZED';
    throw error;
  }
  codes.delete(normalized); // Consume code
  return true;
}

module.exports = {
  generateTotpSecret,
  generateTotp,
  verifyTotp,
  generateOtpauthUri,
  requireMfa,
  generateBackupCodes,
  useBackupCode,
  userBackupCodes,
  trustDevice,
  isTrustedDevice,
  revokeTrustedDevice,
  trustedDevices,
};
