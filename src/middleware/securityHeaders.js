'use strict';

/**
 * HTTP response security headers middleware (#516).
 *
 * Applies OWASP-recommended defensive headers across API responses to prevent
 * MIME-sniffing, clickjacking, protocol downgrade attacks, cross-origin leaks,
 * and framework fingerprinting.
 */

const DEFAULT_SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '0',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
});

/**
 * Creates an Express middleware that sets defensive security headers and strips
 * `X-Powered-By`.
 *
 * @param {Object} [customHeaders={}] Optional header overrides.
 * @returns {Function} Express middleware `(req, res, next)`
 */
function securityHeadersMiddleware(customHeaders = {}) {
  const headersToApply = {
    ...DEFAULT_SECURITY_HEADERS,
    ...customHeaders,
  };

  return function applySecurityHeaders(req, res, next) {
    if (res && typeof res.removeHeader === 'function') {
      res.removeHeader('X-Powered-By');
    }

    if (res && typeof res.setHeader === 'function') {
      for (const [headerName, headerValue] of Object.entries(headersToApply)) {
        if (headerValue !== null && headerValue !== undefined && headerValue !== false) {
          res.setHeader(headerName, String(headerValue));
        }
      }
    }

    if (typeof next === 'function') {
      next();
    }
  };
}

module.exports = {
  DEFAULT_SECURITY_HEADERS,
  securityHeadersMiddleware,
};
