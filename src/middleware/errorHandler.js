'use strict';

const AppError = require('../errors/AppError');
const logger = require('../logger');

function notFoundHandler(req, _res, next) {
  next(new AppError('NOT_FOUND', 'Resource does not exist', 404, { path: req.originalUrl }));
}

function errorHandler(err, req, res, _next) {
  const isAppError = err instanceof AppError;
  const isPayloadTooLarge = !isAppError && err.type === 'entity.too.large';
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
  }

  if ((!isAppError && !isPayloadTooLarge) || status >= 500) {
    logger.error('Unhandled error', { error: err.message, stack: err.stack, request_id: req.id });
  }

  const error = { code, message, request_id: req.id };
  if (isAppError && err.details && Object.keys(err.details).length > 0) {
    error.details = err.details;
  }

  res.status(status).json({ error });
}

module.exports = { errorHandler, notFoundHandler };
