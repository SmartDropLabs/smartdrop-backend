'use strict';

const AppError = require('../errors/AppError');
const logger = require('../logger');
const errorTracker = require('../services/errorTracker');

/**
 * Standardized error response format (#491).
 *
 * All error responses use: `{ error: { code, message, request_id, details? } }`
 * Use `sendError(res, status, code, message, details)` from route handlers
 * to ensure consistency with the centralized errorHandler.
 */
function sendError(res, status, code, message, details) {
  const error = { code, message, request_id: res.req?.id };
  if (details && Object.keys(details).length > 0) {
    error.details = details;
  }
  return res.status(status).json({ error });
}

/**
 * Strip any stack-trace-like content from an error message (#449).
 * Stack traces contain file paths, line numbers, and internal method
 * names that should never reach the client.
 */
function sanitizeMessage(msg) {
  if (typeof msg !== 'string') return 'An unexpected error occurred';
  // Remove common stack-trace patterns: "at ...", file paths, line numbers.
  let cleaned = msg
    .replace(/\n\s+at\s+[^\n]+/g, '')           // "  at fnName (file:line:col)"
    .replace(/\n\s+from\s+[^\n]+/g, '')         // "  from module:line"
    .replace(/file:\/\/\/[^\s]+/g, '[internal]') // file:// URLs
    .replace(/\/[a-z0-9_/.-]+\.js:\d+/gi, '[internal]') // .js:line refs
    .replace(/\/[a-z0-9_/.-]+\.ts:\d+/gi, '[internal]'); // .ts:line refs
  // Truncate to prevent log-injection via long messages.
  if (cleaned.length > 500) cleaned = cleaned.slice(0, 500) + '…';
  return cleaned.trim() || 'An unexpected error occurred';
}

function notFoundHandler(req, _res, next) {
  next(new AppError('NOT_FOUND', 'Resource does not exist', 404, { path: req.originalUrl }));
}

function errorHandler(err, req, res, _next) {
  const isAppError = err instanceof AppError;
  const isPayloadTooLarge = !isAppError && (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413);
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'An unexpected error occurred';

  if (isAppError) {
    status = err.statusCode;
    code = err.code;
    message = err.message;
  } else if (err.isCircuitBreakerError || err.name === 'CircuitBreakerOpenError') {
    status = 503;
    code = 'SERVICE_UNAVAILABLE';
    message = err.message || 'Service temporarily unavailable';
    if (err.retryAfter) {
      res.setHeader('Retry-After', String(err.retryAfter));
    }
  } else if (isPayloadTooLarge) {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'Request body is too large';
  } else if (err.status || err.statusCode) {
    status = err.status || err.statusCode;
    const STATUS_CODES = { 400: 'VALIDATION_ERROR', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 413: 'PAYLOAD_TOO_LARGE', 429: 'RATE_LIMITED', 503: 'SERVICE_UNAVAILABLE' };
    code = STATUS_CODES[status] || 'INTERNAL_ERROR';
    message = err.message || 'Request rejected';
    if (err.retryAfter || err.retry_after) {
      res.setHeader('Retry-After', String(err.retryAfter || err.retry_after));
    }
  }

  // Clients switch on `code`, so an unregistered value would be a code they
  // cannot have written a handler for. Anything not in the registry is
  // reported as INTERNAL_ERROR rather than leaked as a one-off string.
  if (!AppError.isKnownCode(code)) {
    logger.error('Unregistered error code, reporting as INTERNAL_ERROR', { attempted_code: code });
    code = 'INTERNAL_ERROR';
  }

  if (status >= 500) {
    logger.error('Server error', { error: err.message, stack: err.stack, request_id: req.id });
    errorTracker.captureException(err, { request_id: req.id, path: req.originalUrl, method: req.method, status });
  } else if (status >= 400 && (!isAppError && !isPayloadTooLarge)) {
    logger.warn('Client error', { error: err.message, status, request_id: req.id });
  }

  // #449 — Sanitize the message before sending to the client to prevent
  // stack traces, file paths, or other internal details from leaking.
  const safeMessage = sanitizeMessage(message);
  const error = { code, message: safeMessage, request_id: req.id };
  if (isAppError && err.details && Object.keys(err.details).length > 0) {
    // Also sanitize details to prevent stack traces in nested fields.
    const safeDetails = {};
    for (const [k, v] of Object.entries(err.details)) {
      safeDetails[k] = typeof v === 'string' ? sanitizeMessage(v) : v;
    }
    error.details = safeDetails;
  }

  const { renderSafeErrorHtml } = require('../utils/htmlEscape');

  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.accepts && req.accepts('html') && !req.accepts('json')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(status).send(
      renderSafeErrorHtml({ title: code, message: safeMessage, statusCode: status })
    );
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(status).json({ error });
}

module.exports = { errorHandler, notFoundHandler, sendError };
