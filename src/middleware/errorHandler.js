'use strict';

const AppError = require('../errors/AppError');
const logger = require('../logger');

function notFoundHandler(req, _res, next) {
  next(new AppError('NOT_FOUND', 'Resource does not exist', 404, { path: req.originalUrl }));
}

function errorHandler(err, req, res, _next) {
  const isAppError = err instanceof AppError;
  const status = isAppError ? err.statusCode : 500;
  const code = isAppError ? err.code : 'INTERNAL_ERROR';
  const message = isAppError ? err.message : 'An unexpected error occurred';

  if (!isAppError || status >= 500) {
    logger.error('Unhandled error', { error: err.message, stack: err.stack, request_id: req.id });
  }

  const error = { code, message, request_id: req.id };
  if (isAppError && err.details && Object.keys(err.details).length > 0) {
    error.details = err.details;
  }

  res.status(status).json({ error });
}

module.exports = { errorHandler, notFoundHandler };
