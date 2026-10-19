'use strict';

/**
 * Response header injection / HTTP response splitting prevention middleware (Issue #499).
 *
 * Intercepts response header operations to reject or neutralize any carriage return (\r)
 * or line feed (\n) characters that could allow header injection or response splitting.
 */

function sanitizeHeaderString(val) {
  if (typeof val !== 'string') return val;
  if (/[\r\n\0]/.test(val)) {
    const error = new Error('Header value contains invalid CR/LF characters (header injection rejected)');
    error.statusCode = 400;
    error.code = 'INVALID_HEADER';
    throw error;
  }
  return val;
}

function headerSecurityMiddleware(_req, res, next) {
  const originalSetHeader = res.setHeader.bind(res);

  res.setHeader = (name, value) => {
    sanitizeHeaderString(name);

    if (Array.isArray(value)) {
      value.forEach(sanitizeHeaderString);
    } else {
      sanitizeHeaderString(value);
    }

    return originalSetHeader(name, value);
  };

  next();
}

module.exports = {
  headerSecurityMiddleware,
  sanitizeHeaderString,
};
