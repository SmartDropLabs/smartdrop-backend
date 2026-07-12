'use strict';

const {
  fetchWithRetry,
  isRetryableStatus,
  parseRetryAfter,
} = require('../src/utils/fetchWithRetry');

function buildError(status, headers = {}) {
  const err = new Error(status ? `HTTP ${status}` : 'network failed');
  if (status) {
    err.response = { status, headers };
  }
  return err;
}

describe('fetchWithRetry', () => {
  test('succeeds on the second attempt after a retryable network error', async () => {
    const client = {
      get: jest
        .fn()
        .mockRejectedValueOnce(buildError())
        .mockResolvedValueOnce({ data: { ok: true } }),
    };
    const sleep = jest.fn(async () => {});
    const logger = { debug: jest.fn() };

    const response = await fetchWithRetry('/price', { client, sleep, logger }, 3, 500);

    expect(response.data.ok).toBe(true);
    expect(client.get).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
    expect(logger.debug).toHaveBeenCalledWith(
      'Retrying price source request',
      expect.objectContaining({ attempt: 2, maxAttempts: 4, delayMs: 500, status: null })
    );
  });

  test('throws after the maximum retry count is exhausted', async () => {
    const client = {
      get: jest.fn().mockRejectedValue(buildError(503)),
    };
    const sleep = jest.fn(async () => {});

    await expect(fetchWithRetry('/price', { client, sleep, logger: { debug: jest.fn() } }, 2, 500))
      .rejects
      .toThrow('HTTP 503');

    expect(client.get).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 500);
    expect(sleep).toHaveBeenNthCalledWith(2, 2000);
  });

  test('does not retry non-retryable 401 responses', async () => {
    const client = {
      get: jest.fn().mockRejectedValue(buildError(401)),
    };
    const sleep = jest.fn(async () => {});

    await expect(fetchWithRetry('/price', { client, sleep, logger: { debug: jest.fn() } }))
      .rejects
      .toThrow('HTTP 401');

    expect(client.get).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test('honors Retry-After seconds for 429 responses', async () => {
    const client = {
      get: jest
        .fn()
        .mockRejectedValueOnce(buildError(429, { 'retry-after': '2' }))
        .mockResolvedValueOnce({ data: { ok: true } }),
    };
    const sleep = jest.fn(async () => {});

    await fetchWithRetry('/price', { client, sleep, logger: { debug: jest.fn() } });

    expect(sleep).toHaveBeenCalledWith(2000);
  });

  test('classifies retryable and non-retryable statuses', () => {
    expect(isRetryableStatus(undefined)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
  });

  test('parses Retry-After dates', () => {
    const delay = parseRetryAfter('Sat, 04 Jul 2026 00:00:05 GMT', Date.parse('Sat, 04 Jul 2026 00:00:00 GMT'));

    expect(delay).toBe(5000);
  });
});
