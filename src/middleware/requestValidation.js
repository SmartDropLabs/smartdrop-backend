'use strict';

const AppError = require('../errors/AppError');

const ALLOWED_CONTENT_TYPES = ['application/json', 'multipart/form-data', 'text/csv'];

function requestValidation(options = {}) {
  const {
    allowedContentTypes = ALLOWED_CONTENT_TYPES,
  } = options;

  return (req, _res, next) => {
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();

    if (['POST', 'PUT', 'PATCH'].includes(req.method) && contentType) {
      if (!allowedContentTypes.some((t) => contentType === t)) {
        return next(new AppError('VALIDATION_ERROR', `Unsupported Content-Type: ${contentType}`, 415));
      }
    }

    return next();
  };
}

module.exports = { requestValidation };
