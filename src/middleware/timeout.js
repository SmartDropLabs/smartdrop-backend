'use strict';

const AppError = require('../errors/AppError');
const config = require('../config');

/**
 * Creates per-route timeout middleware.
 * If the response does not finish within `timeoutMs`, it yields a 504 TIMEOUT error.
 */
function routeTimeout(timeoutMs = config.routeTimeoutMs || 30000) {
  return (req, res, next) => {
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        return next(new AppError('TIMEOUT', 'Route execution timed out', 504, { timeout_ms: timeoutMs }));
      }
    }, timeoutMs);

    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));

    next();
  };
}

module.exports = { routeTimeout };
