'use strict';

const crypto = require('crypto');
const AppError = require('../errors/AppError');
const logger = require('../logger');
const errorTracker = require('../services/errorTracker');
const { translate, getLocale } = require('../services/i18n');

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

/**
 * Deep-copy error details for the client with every `stack` property removed
 * and string values sanitized (#619). Details are caller-supplied and can
 * carry nested error objects whose stacks would otherwise be serialized.
 */
function sanitizeDetails(value, depth = 0) {
  if (typeof value === 'string') return sanitizeMessage(value);
  if (!value || typeof value !== 'object' || depth > 5) return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeDetails(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'stack') continue;
    out[k] = sanitizeDetails(v, depth + 1);
  }
  return out;
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function notFoundHandler(req, _res, next) {
  next(new AppError('NOT_FOUND', 'Resource does not exist', 404, { path: req.originalUrl }));
}

function errorHandler(err, req, res, _next) {
  const isAppError = err instanceof AppError;
  const isPayloadTooLarge = !isAppError && (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413);
  const locale = getLocale(req);
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = translate('INTERNAL_ERROR', locale);

  if (isAppError) {
    status = err.statusCode;
    code = err.code;
    message = err.message;
  } else if (err.isCircuitBreakerError || err.name === 'CircuitBreakerOpenError') {
    status = 503;
    code = 'SERVICE_UNAVAILABLE';
    message = err.message || translate('SERVICE_UNAVAILABLE', locale);
    if (err.retryAfter) {
      res.setHeader('Retry-After', String(err.retryAfter));
    }
  } else if (isPayloadTooLarge) {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = translate('PAYLOAD_TOO_LARGE', locale);
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
  // #571 — Localize standard error messages based on the client's language preference.
  // #619 — in production a 5xx never echoes its own message or details: those
  // describe internals (query text, file paths, upstream errors). The full
  // error and stack are still logged and sent to the error tracker above.
  const correlationId = req.id || req.headers?.['x-correlation-id'] || crypto.randomUUID();
  res.setHeader('X-Correlation-Id', correlationId);

  const hideInternals = isProduction() && status >= 500;
  const safeMessage = hideInternals
    ? translate('INTERNAL_ERROR', locale)
    : sanitizeMessage(message);
  const localizedMessage = translate(code, locale) !== code ? translate(code, locale) : safeMessage;
  const error = { code, message: localizedMessage, request_id: correlationId };
  if (!hideInternals && isAppError && err.details && Object.keys(err.details).length > 0) {
    // Also sanitize details to prevent stack traces in nested fields.
    error.details = sanitizeDetails(err.details);
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

module.exports = { errorHandler, notFoundHandler, sendError, sanitizeDetails };
