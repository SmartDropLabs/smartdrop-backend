'use strict';

const AppError = require('../errors/AppError');

// Forbidden control characters: null byte and non-printable ASCII controls,
// preserving legitimate whitespace: \t (0x09), \n (0x0A), \r (0x0D).
const FORBIDDEN_CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const PATH_TRAVERSAL_RE = /(?:^|[/\\])\.\.(?:[/\\]|$)|%2e%2e|\.\.%2f|\.\.%5c/i;

function hasForbiddenControlChars(val) {
  if (typeof val === 'string') {
    return FORBIDDEN_CONTROL_CHARS_RE.test(val);
  }
  if (Array.isArray(val)) {
    return val.some(hasForbiddenControlChars);
  }
  if (val !== null && typeof val === 'object') {
    for (const key of Object.keys(val)) {
      if (hasForbiddenControlChars(key) || hasForbiddenControlChars(val[key])) {
        return true;
      }
    }
  }
  return false;
}

function hasNoSqlOperator(val) {
  if (val !== null && typeof val === 'object') {
    if (Array.isArray(val)) {
      return val.some(hasNoSqlOperator);
    }
    for (const key of Object.keys(val)) {
      if (key.startsWith('$') || key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return true;
      }
      if (hasNoSqlOperator(val[key])) {
        return true;
      }
    }
  }
  return false;
}

function hasPathTraversal(val) {
  if (typeof val === 'string') {
    return PATH_TRAVERSAL_RE.test(val);
  }
  if (Array.isArray(val)) {
    return val.some(hasPathTraversal);
  }
  if (val !== null && typeof val === 'object') {
    for (const key of Object.keys(val)) {
      if (hasPathTraversal(key) || hasPathTraversal(val[key])) {
        return true;
      }
    }
  }
  return false;
}

/**
 * #450 / #459 — Central Request Validation and Sanitization Middleware.
 *
 * Validates and sanitizes incoming requests across all endpoints:
 * 1. Rejects POST/PUT/PATCH without Content-Type or with unsupported types
 * 2. Enforces request body size limits
 * 3. Rejects null bytes and forbidden control characters
 * 4. Guards against NoSQL-style operator objects ($gt, $ne, $where, prototype pollution)
 * 5. Guards against path traversal in route parameters and query strings
 * 6. Ensures legitimate special characters (names with apostrophes, passwords,
 *    Stellar addresses, base64 payloads, and SQL strings) survive unmodified.
 */
function requestValidationMiddleware(req, res, next) {
  const method = req.method.toUpperCase();

  // 1. Content-Type validation
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    const contentType = req.headers['content-type'];
    const contentLength = req.headers['content-length'];

    if (!contentType) {
      if (contentLength && contentLength !== '0') {
        return next(new AppError(
          'VALIDATION_ERROR',
          'Content-Type header is required for this request',
          400,
          { method, hint: 'Use Content-Type: application/json' },
        ));
      }
    } else {
      const normalizedContentType = contentType.split(';')[0].trim().toLowerCase();
      if (normalizedContentType !== 'application/json' && normalizedContentType !== 'multipart/form-data') {
        return next(new AppError(
          'VALIDATION_ERROR',
          `Unsupported Content-Type: ${contentType}`,
          400,
          { method, content_type: contentType, expected: 'application/json' },
        ));
      }
    }
  }

  // 2. Request body size check (Content-Length header check)
  if (req.headers['content-length']) {
    const length = parseInt(req.headers['content-length'], 10);
    const MAX_ALLOWED_BODY_BYTES = 10 * 1024 * 1024; // 10MB
    if (Number.isFinite(length) && length > MAX_ALLOWED_BODY_BYTES) {
      return next(new AppError(
        'PAYLOAD_TOO_LARGE',
        'Request body exceeds maximum allowed size',
        413,
        { max_bytes: MAX_ALLOWED_BODY_BYTES, received_bytes: length },
      ));
    }
  }

  // 3. Null bytes and control characters check across body, query and params
  if (hasForbiddenControlChars(req.query) || hasForbiddenControlChars(req.params) || hasForbiddenControlChars(req.body)) {
    return next(new AppError(
      'VALIDATION_ERROR',
      'Input contains invalid control characters or null bytes',
      400,
    ));
  }

  // 4. NoSQL operator and prototype pollution check
  if (hasNoSqlOperator(req.body) || hasNoSqlOperator(req.query)) {
    return next(new AppError(
      'VALIDATION_ERROR',
      'Invalid operator in request',
      400,
    ));
  }

  // 5. Path traversal guard on route parameters and query strings
  if (hasPathTraversal(req.params) || hasPathTraversal(req.query)) {
    return next(new AppError(
      'VALIDATION_ERROR',
      'Path traversal sequence detected',
      400,
    ));
  }

  next();
}

module.exports = requestValidationMiddleware;
