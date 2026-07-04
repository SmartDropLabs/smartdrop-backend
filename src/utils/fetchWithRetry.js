'use strict';

const axios = require('axios');
const logger = require('../logger');

const NON_RETRYABLE_STATUSES = new Set([400, 401, 403]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(headerValue, now = Date.now()) {
  if (!headerValue) return null;

  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const retryAt = Date.parse(headerValue);
  if (Number.isNaN(retryAt)) {
    return null;
  }

  return Math.max(0, retryAt - now);
}

function isRetryableStatus(status) {
  if (!status) return true;
  if (NON_RETRYABLE_STATUSES.has(status)) return false;
  return status === 429 || status >= 500;
}

function getRetryDelay(err, attempt, baseDelayMs) {
  const status = err.response?.status;
  const retryAfter = status === 429
    ? parseRetryAfter(err.response?.headers?.['retry-after'])
    : null;

  if (retryAfter !== null) {
    return retryAfter;
  }

  return baseDelayMs * Math.pow(4, attempt);
}

async function fetchWithRetry(target, options = {}, retries = 3, baseDelayMs = 500) {
  const {
    client = axios,
    logger: retryLogger = logger,
    sleep: sleepFn = sleep,
    label,
    ...requestOptions
  } = options;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      if (typeof target === 'function') {
        return await target();
      }

      return await client.get(target, {
        timeout: 10000,
        ...requestOptions,
      });
    } catch (err) {
      const status = err.response?.status;
      const retryable = isRetryableStatus(status);

      if (!retryable || attempt === retries) {
        throw err;
      }

      const delayMs = getRetryDelay(err, attempt, baseDelayMs);
      retryLogger.debug('Retrying price source request', {
        label: label || (typeof target === 'string' ? target : 'custom-request'),
        attempt: attempt + 2,
        maxAttempts: retries + 1,
        delayMs,
        status: status || null,
      });

      await sleepFn(delayMs);
    }
  }

  return null;
}

module.exports = {
  fetchWithRetry,
  isRetryableStatus,
  parseRetryAfter,
};
