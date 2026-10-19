'use strict';

/**
 * SQL input sanitization middleware (#581).
 *
 * Sanitizes user-supplied inputs to prevent SQL injection attacks.
 * Escapes special characters and rejects obviously malicious patterns.
 */

const SQL_INJECTION_PATTERNS = [
  /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION|FETCH|DECLARE|TRUNCATE)\b)/i,
  /(--|;|\/\*|\*\/|xp_|sp_)/i,
  /(\b(OR|AND)\b\s+\d+\s*=\s*\d+)/i,
  /('.*'|".*")\s*(OR|AND)\s+/i,
  /(SLEEP|BENCHMARK|WAITFOR|LOAD_FILE|INTO\s+OUTFILE)/i,
];

const MAX_INPUT_LENGTH = 5000;

function detectSqlInjection(value) {
  if (typeof value !== 'string') return false;
  return SQL_INJECTION_PATTERNS.some((pattern) => pattern.test(value));
}

function sanitizeValue(value) {
  if (typeof value !== 'string') return value;
  // Remove null bytes
  let sanitized = value.replace(/\0/g, '');
  // Escape single quotes (double them for SQL)
  sanitized = sanitized.replace(/'/g, "''");
  // Remove backslashes
  sanitized = sanitized.replace(/\\/g, '');
  return sanitized;
}

function sanitizeObject(obj, depth = 0) {
  if (depth > 10) return obj;
  if (typeof obj === 'string') return sanitizeValue(obj);
  if (Array.isArray(obj)) return obj.map((item) => sanitizeObject(item, depth + 1));
  if (obj !== null && typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = sanitizeObject(value, depth + 1);
    }
    return result;
  }
  return obj;
}

/**
 * Express middleware that sanitizes request inputs against SQL injection.
 * Rejects requests containing SQL injection patterns with 400.
 */
function sqlSanitize(options = {}) {
  const { rejectOnDetection = true } = options;

  return (req, res, next) => {
    const sources = [req.body, req.query, req.params];
    const errors = [];

    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      checkForInjection(source, '', errors);
    }

    if (errors.length > 0 && rejectOnDetection) {
      return res.status(400).json({
        error: 'Input validation failed',
        message: 'Potentially malicious SQL patterns detected.',
        details: errors,
      });
    }

    // Sanitize inputs
    if (req.body && typeof req.body === 'object') {
      req.body = sanitizeObject(req.body);
    }

    next();
  };
}

function checkForInjection(obj, path, errors, depth = 0) {
  if (depth > 10) return;
  if (typeof obj === 'string') {
    if (detectSqlInjection(obj)) {
      errors.push(`${path || 'value'} contains potentially malicious SQL patterns`);
    }
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => checkForInjection(item, `${path}[${i}]`, errors, depth + 1));
    return;
  }
  if (obj !== null && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      checkForInjection(value, path ? `${path}.${key}` : key, errors, depth + 1);
    }
  }
}

module.exports = {
  sqlSanitize,
  detectSqlInjection,
  sanitizeValue,
  sanitizeObject,
};
