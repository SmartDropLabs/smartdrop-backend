'use strict';

const logger = require('../logger');

const ALLOWED_CONTENT_TYPES = new Set([
  'application/json',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
  'application/octet-stream',
]);

function contentTypeValidationMiddleware(req, res, next) {
  const contentType = req.get('content-type');

  if (!req.method || ['GET', 'HEAD', 'DELETE'].includes(req.method)) {
    return next();
  }

  if (!contentType) {
    logger.warn('Request missing Content-Type header', {
      method: req.method,
      path: req.path,
      ip: req.ip,
    });
    return res.status(400).json({
      error: 'Content-Type header is required',
      code: 'MISSING_CONTENT_TYPE',
    });
  }

  const baseContentType = contentType.split(';')[0].trim().toLowerCase();

  if (!ALLOWED_CONTENT_TYPES.has(baseContentType)) {
    logger.warn('Request rejected: invalid Content-Type', {
      method: req.method,
      path: req.path,
      contentType: baseContentType,
      ip: req.ip,
    });
    return res.status(415).json({
      error: `Unsupported Media Type: ${baseContentType}`,
      code: 'UNSUPPORTED_MEDIA_TYPE',
    });
  }

  next();
}

module.exports = {
  contentTypeValidationMiddleware,
};
