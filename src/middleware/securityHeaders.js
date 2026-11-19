'use strict';

/**
 * Security headers middleware (#516).
 *
 * Adds standard security headers to all API responses to prevent XSS,
 * clickjacking, MIME-type sniffing, and other common web vulnerabilities.
 */

const SECURITY_HEADERS = {
  // Prevent MIME-type sniffing
  'X-Content-Type-Options': 'nosniff',
  // Prevent clickjacking
  'X-Frame-Options': 'DENY',
  // XSS protection (legacy browsers)
  'X-XSS-Protection': '1; mode=block',
  // Referrer policy — don't leak full URLs to third parties
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Permissions policy — disable powerful browser features
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  // HSTS — force HTTPS (only when served over HTTPS)
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  // Content Security Policy — restrict resource loading
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

/**
 * Apply security headers to the response.
 * @param {Object} _req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next
 */
function securityHeadersMiddleware(_req, res, next) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    // Don't overwrite if already set by another middleware
    if (!res.getHeader(name)) {
      res.setHeader(name, value);
    }
  }
  next();
}

module.exports = {
  securityHeadersMiddleware,
  SECURITY_HEADERS,
};
