'use strict';

const ERROR_CODES = Object.freeze({
  VALIDATION_ERROR: { statusCode: 400 },
  UNAUTHORIZED: { statusCode: 401 },
  NOT_FOUND: { statusCode: 404 },
  PAYLOAD_TOO_LARGE: { statusCode: 413 },
  RATE_LIMITED: { statusCode: 429 },
  UPSTREAM_ERROR: { statusCode: 502 },
  INTERNAL_ERROR: { statusCode: 500 },
});

class AppError extends Error {
  constructor(code, message, statusCode, details = {}) {
    super(message);
    if (!ERROR_CODES[code]) {
      throw new Error(`Unknown application error code: ${code}`);
    }
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode || ERROR_CODES[code].statusCode;
    this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }
}

AppError.codes = ERROR_CODES;

module.exports = AppError;
