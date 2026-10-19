'use strict';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Wraps `fetch()` with a configurable timeout.
 *
 * Returns the `Response` on success. Throws an `Error` with
 * `code: 'ABORT_ERROR'` if the request exceeds `timeoutMs`.
 *
 * Usage:
 *   const res = await fetchWithTimeout(url, { headers }, 5000);
 *   const data = await res.json();
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutErr = new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
      timeoutErr.code = 'ABORT_ERROR';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchWithTimeout };
