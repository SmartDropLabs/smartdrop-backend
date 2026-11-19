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

  // If request has uploaded files, verify MIME type magic signatures (#655)
  if (req.file) {
    try {
      verifyFileContent(req.file);
    } catch (err) {
      return res.status(err.statusCode || 400).json({ error: err.message, code: err.code });
    }
  }

  next();
}

const MAGIC_NUMBERS = {
  'image/jpeg': [[0xFF, 0xD8, 0xFF]],
  'image/png': [[0x89, 0x50, 0x4E, 0x47]],
  'image/gif': [[0x47, 0x49, 0x46, 0x38]],
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]],
  'application/zip': [[0x50, 0x4B, 0x03, 0x04]],
};

/**
 * Verify whether binary buffer matches expected MIME magic bytes (#655).
 * @param {Buffer} buffer - File header buffer
 * @param {string} expectedMime - Declared MIME type
 * @returns {boolean}
 */
function isValidMime(buffer, expectedMime) {
  if (!buffer || buffer.length === 0) return false;
  if (!expectedMime) return true;
  const normalizedMime = expectedMime.split(';')[0].trim().toLowerCase();
  const signatures = MAGIC_NUMBERS[normalizedMime];
  if (!signatures) return true;
  return signatures.some(sig =>
    sig.every((byte, index) => buffer[index] === byte)
  );
}

/**
 * Validate that uploaded file content matches its declared MIME type (#655).
 * @param {Object|Buffer} file - Express multer file or raw buffer
 * @param {string} [expectedContentType] - Target MIME type
 */
function verifyFileContent(file, expectedContentType) {
  if (!file) return true;
  const buffer = file.buffer || (Buffer.isBuffer(file) ? file : null);
  if (!buffer) return true;
  const targetType = expectedContentType || file.mimetype || file.type;
  if (!isValidMime(buffer, targetType)) {
    const error = new Error('File type mismatch: content does not match declared MIME type');
    error.statusCode = 400;
    error.code = 'MIME_TYPE_MISMATCH';
    throw error;
  }
  return true;
}

module.exports = {
  contentTypeValidationMiddleware,
  isValidMime,
  verifyFileContent,
  ALLOWED_CONTENT_TYPES,
};
