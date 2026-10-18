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

/**
 * Middleware that requires MFA verification for sensitive operations.
 * Expects X-MFA-Token header with the current TOTP code.
 */
function requireMfa(userSecret) {
  return (req, res, next) => {
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

    next();
  };
}

module.exports = {
  generateTotpSecret,
  generateTotp,
  verifyTotp,
  generateOtpauthUri,
  requireMfa,
};
