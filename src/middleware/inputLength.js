'use strict';

/**
 * Input length validation middleware (#523).
 *
 * Validates that string fields in request body/query/params do not exceed
 * configured maximum lengths. Prevents buffer overflow, database issues,
 * and other security vulnerabilities from oversized inputs.
 */

const DEFAULT_MAX_STRING_LENGTH = 5000;
const DEFAULT_MAX_ARRAY_LENGTH = 100;

/** Per-field maximum lengths for known fields. */
const FIELD_MAX_LENGTHS = {
  // General fields
  name: 200,
  description: 5000,
  url: 2000,
  email: 320,
  phone: 20,
  message: 5000,
  comment: 5000,
  note: 1000,
  title: 200,
  reason: 500,
  note: 1000,

  // Stellar-specific
  address: 56,
  memo: 28,
  memoText: 28,
  txHash: 64,
  secret: 56,

  // Identifiers
  id: 100,
  slug: 100,
  token: 500,
  apiKey: 100,

  // Content
  bio: 1000,
  content: 10000,
  body: 10000,
};

function getMaxLength(field, defaultValue) {
  return FIELD_MAX_LENGTHS[field] ?? defaultValue;
}

function checkStringLengths(obj, path = '', errors = []) {
  if (obj === null || obj === undefined) return errors;

  if (typeof obj === 'string') {
    const field = path.split('.').pop();
    const max = getMaxLength(field, DEFAULT_MAX_STRING_LENGTH);
    if (obj.length > max) {
      errors.push(`${path || 'value'} exceeds maximum length of ${max} (got ${obj.length})`);
    }
    return errors;
  }

  if (Array.isArray(obj)) {
    if (obj.length > DEFAULT_MAX_ARRAY_LENGTH) {
      errors.push(`${path || 'array'} exceeds maximum length of ${DEFAULT_MAX_ARRAY_LENGTH} (got ${obj.length})`);
    }
    obj.forEach((item, index) => checkStringLengths(item, `${path}[${index}]`, errors));
    return errors;
  }

  if (typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      checkStringLengths(value, path ? `${path}.${key}` : key, errors);
    }
  }

  return errors;
}

/**
 * Express middleware that validates input lengths.
 * Rejects requests with 400 if any field exceeds its maximum length.
 */
function inputLengthValidation(options = {}) {
  const {
    maxStringLength = DEFAULT_MAX_STRING_LENGTH,
    maxArrayLength = DEFAULT_MAX_ARRAY_LENGTH,
    fields = {},
  } = options;

  // Merge custom field limits with defaults
  const maxLimits = { ...FIELD_MAX_LENGTHS, ...fields };

  return (req, res, next) => {
    const errors = [];

    // Validate body
    if (req.body && typeof req.body === 'object') {
      checkStringLengths(req.body, 'body', errors);
    }

    // Validate query params
    if (req.query && typeof req.query === 'object') {
      checkStringLengths(req.query, 'query', errors);
    }

    // Validate route params
    if (req.params && typeof req.params === 'object') {
      checkStringLengths(req.params, 'params', errors);
    }

    if (errors.length > 0) {
      return res.status(400).json({
        error: 'Input validation failed',
        message: 'One or more fields exceed maximum allowed length.',
        details: errors,
      });
    }

    next();
  };
}

module.exports = {
  inputLengthValidation,
  FIELD_MAX_LENGTHS,
  DEFAULT_MAX_STRING_LENGTH,
  DEFAULT_MAX_ARRAY_LENGTH,
  checkStringLengths,
};
