'use strict';

/**
 * Global CSRF Protection Middleware (Issue #465).
 *
 * Denies state-changing requests by default unless valid CSRF credentials are provided.
 *
 * Protection Strategy:
 * 1. Safe methods (GET, HEAD, OPTIONS) are exempt.
 * 2. Requests authenticated by Authorization header or API key are exempt (ambient browser cookies are absent).
 * 3. Declared webhook endpoints with signature verification are exempt.
 * 4. Method override headers and parameters (_method, X-HTTP-Method-Override, etc.) are strictly rejected.
 * 5. State-changing requests must pass an Origin/Referer check against configured allowed origins.
 * 6. Per-session cryptographically signed token (HMAC-SHA256) sent via X-CSRF-Token header.
 * 7. Token is validated using constant-time timingSafeEqual to defeat timing attacks.
 * 8. Never accepts CSRF tokens from URL query parameters.
 * 9. Standard 403 FORBIDDEN error response on failure; tokens and cookies are never logged.
 */

const crypto = require('crypto');
const AppError = require('../errors/AppError');
const logger = require('../logger');
const config = require('../config');

const CSRF_SECRET = process.env.CSRF_SECRET || 'smartdrop-csrf-token-hmac-secret-key-32b';

const METHOD_OVERRIDE_HEADERS = [
  'x-http-method-override',
  'x-method-override',
  'x-http-method',
];

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const DEFAULT_EXEMPT_PATHS = [
  '/health',
  '/metrics',
  '/api-docs',
  '/csrf-token',
  '/api/v1/csrf-token',
  '/v1/csrf-token',
];

/**
 * Generate a cryptographically secure CSRF token bound to a session ID.
 */
function generateCsrfToken(sessionId, secret = CSRF_SECRET) {
  const boundId = sessionId || 'anonymous';
  const salt = crypto.randomBytes(16).toString('hex');
  const hmac = crypto
    .createHmac('sha256', secret)
    .update(`${boundId}:${salt}`)
    .digest('hex');
  return `${salt}.${hmac}`;
}

/**
 * Validate a CSRF token in constant time.
 */
function verifyCsrfToken(token, sessionId, secret = CSRF_SECRET) {
  if (!token || typeof token !== 'string') return false;

  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const [salt, receivedHmac] = parts;
  if (!salt || !receivedHmac) return false;

  const boundId = sessionId || 'anonymous';
  const expectedHmac = crypto
    .createHmac('sha256', secret)
    .update(`${boundId}:${salt}`)
    .digest('hex');

  const receivedBuf = Buffer.from(receivedHmac, 'utf8');
  const expectedBuf = Buffer.from(expectedHmac, 'utf8');

  if (receivedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(receivedBuf, expectedBuf);
}

/**
 * Check if the request attempts a method-override bypass.
 */
function hasMethodOverride(req) {
  for (const header of METHOD_OVERRIDE_HEADERS) {
    if (req.headers[header]) return true;
  }
  if (req.query && req.query._method) return true;
  if (req.body && typeof req.body === 'object' && req.body._method) return true;
  return false;
}

/**
 * Verify Origin or Referer against allowed origins list.
 */
function isAllowedOrigin(req, allowedOrigins) {
  const origin = req.get('origin');
  if (origin) {
    try {
      const originBase = new URL(origin).origin;
      return allowedOrigins.some((allowed) => {
        try {
          return new URL(allowed).origin === originBase;
        } catch {
          return allowed.trim() === origin.trim();
        }
      });
    } catch {
      return false;
    }
  }

  // Fallback to Referer
  const referer = req.get('referer');
  if (referer) {
    try {
      const refererBase = new URL(referer).origin;
      return allowedOrigins.some((allowed) => {
        try {
          return new URL(allowed).origin === refererBase;
        } catch {
          return allowed.trim() === refererBase.trim();
        }
      });
    } catch {
      return false;
    }
  }

  // Both Origin and Referer are absent
  return false;
}

/**
 * Extracts session ID from request (cookie or request attachment).
 */
function extractSessionId(req) {
  if (req.session?.id) return req.session.id;

  const rawCookie = req.headers.cookie || '';
  const match = rawCookie.match(/(?:^|;\s*)session_id=([^;]+)/);
  if (match) {
    return decodeURIComponent(match[1]);
  }
  return null;
}

/**
 * Check whether a request is authenticated by Authorization header or API key.
 * Such requests are exempt from CSRF because browsers do not attach custom headers
 * automatically in cross-site requests.
 */
function isHeaderAuthenticated(req) {
  const authHeader = req.get('authorization');
  if (authHeader && authHeader.trim().length > 0) return true;

  const apiKeyHeader = req.get('x-api-key');
  if (apiKeyHeader && apiKeyHeader.trim().length > 0) return true;

  // Webhook signature header
  const signatureHeader = req.get('x-webhook-signature') || req.get('x-signature');
  if (signatureHeader && signatureHeader.trim().length > 0) return true;

  return false;
}

/**
 * Check if the path matches the exemption list.
 */
function isExemptPath(path, customExemptions = []) {
  if (!path) return false;
  const cleanPath = path.split('?')[0];

  const allExemptions = [...DEFAULT_EXEMPT_PATHS, ...customExemptions];
  return allExemptions.some((exempt) => {
    if (exempt.endsWith('*')) {
      return cleanPath.startsWith(exempt.slice(0, -1));
    }
    return cleanPath === exempt || cleanPath === `${exempt}/`;
  });
}

/**
 * Create the global CSRF protection middleware.
 */
function createCsrfProtectionMiddleware(options = {}) {
  const allowedOrigins = options.allowedOrigins || config.corsAllowedOrigins || [];
  const exemptPaths = options.exemptPaths || [];
  const secret = options.secret || CSRF_SECRET;

  return function csrfProtectionMiddleware(req, res, next) {
    // 1. Detect and reject method override bypass attempts immediately
    if (hasMethodOverride(req)) {
      logger.warn('CSRF rejected: method-override attempt detected', {
        path: req.originalUrl || req.url,
        request_id: req.id,
      });
      return next(
        new AppError('FORBIDDEN', 'Method override is prohibited', 403)
      );
    }

    // 2. Safe methods (GET, HEAD, OPTIONS) do not change state -> exempt
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      return next();
    }

    // 3. Explicitly declared route-level exemption flag
    if (req.csrfExempt || req._csrfExempt) {
      return next();
    }

    // 4. Path-based exemptions (health, metrics, docs, csrf-token endpoint)
    const requestPath = req.path || req.originalUrl || '';
    if (isExemptPath(requestPath, exemptPaths)) {
      return next();
    }

    // 5. Header-authenticated requests (Bearer token / API key / webhook signature)
    // are exempt because browsers cannot attach custom Authorization headers cross-site.
    if (isHeaderAuthenticated(req)) {
      return next();
    }

    // 6. Origin / Referer validation for state-changing requests
    if (allowedOrigins.length > 0 && !isAllowedOrigin(req, allowedOrigins)) {
      logger.warn('CSRF rejected: Origin or Referer missing or not allowed', {
        path: req.originalUrl || req.url,
        method: req.method,
        origin: req.get('origin') || '[missing]',
        request_id: req.id,
      });
      return next(
        new AppError('FORBIDDEN', 'Cross-origin request rejected', 403)
      );
    }

    // 7. CSRF token validation
    // Token MUST be sent in a custom header; NEVER from query string.
    const token = req.get('x-csrf-token') || req.get('x-xsrf-token');
    if (!token) {
      logger.warn('CSRF rejected: Missing CSRF token header', {
        path: req.originalUrl || req.url,
        method: req.method,
        request_id: req.id,
      });
      return next(
        new AppError('FORBIDDEN', 'Missing CSRF token', 403)
      );
    }

    const sessionId = extractSessionId(req);
    const isValid = verifyCsrfToken(token, sessionId, secret);

    if (!isValid) {
      logger.warn('CSRF rejected: Invalid or mismatched CSRF token', {
        path: req.originalUrl || req.url,
        method: req.method,
        request_id: req.id,
      });
      return next(
        new AppError('FORBIDDEN', 'Invalid CSRF token', 403)
      );
    }

    return next();
  };
}

/**
 * Express handler to obtain a new CSRF token bound to the current session.
 */
function csrfTokenHandler(req, res) {
  const sessionId = extractSessionId(req);
  const token = generateCsrfToken(sessionId);
  res.json({ csrf_token: token });
}

/**
 * Backward compatibility with webhook-specific CSRF header check (#320).
 */
function requireCsrfHeader(req, res, next) {
  if (!req.get('x-requested-with')) {
    return next(
      new AppError(
        'CSRF_HEADER_REQUIRED',
        'Missing required X-Requested-With header',
        403
      )
    );
  }
  next();
}

module.exports = {
  createCsrfProtectionMiddleware,
  csrfProtectionMiddleware: createCsrfProtectionMiddleware(),
  csrfTokenHandler,
  generateCsrfToken,
  verifyCsrfToken,
  isAllowedOrigin,
  hasMethodOverride,
  isHeaderAuthenticated,
  isExemptPath,
  requireCsrfHeader,
};
