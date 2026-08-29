'use strict';

const AppError = require('../errors/AppError');
const logger = require('../logger');
const errorTracker = require('../services/errorTracker');

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
  } else if (isPayloadTooLarge) {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'Request body is too large';
  } else if (err.status || err.statusCode) {
    status = err.status || err.statusCode;
    const STATUS_CODES = { 400: 'VALIDATION_ERROR', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 413: 'PAYLOAD_TOO_LARGE', 429: 'RATE_LIMITED' };
    code = STATUS_CODES[status] || 'INTERNAL_ERROR';
    message = err.message || 'Request rejected';
  }

  // Clients switch on `code`, so an unregistered value would be a code they
  // cannot have written a handler for. Anything not in the registry is
  // reported as INTERNAL_ERROR rather than leaked as a one-off string.
  if (!AppError.isKnownCode(code)) {
    logger.error('Unregistered error code, reporting as INTERNAL_ERROR', { attempted_code: code });
    code = 'INTERNAL_ERROR';
  }

  if ((!isAppError && !isPayloadTooLarge) || status >= 500) {
    logger.error('Unhandled error', { error: err.message, stack: err.stack, request_id: req.id });
    errorTracker.captureException(err, { request_id: req.id, path: req.originalUrl, method: req.method, status });
  }

  const error = { code, message, request_id: req.id };
  if (isAppError && err.details && Object.keys(err.details).length > 0) {
    error.details = err.details;
  }

  res.status(status).json({ error });
}

module.exports = { errorHandler, notFoundHandler };
