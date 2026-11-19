'use strict';

const {
  runWithRetry,
  isTransientError,
  calculateBackoffDelay,
  getDeadLetterJobs,
  clearDeadLetterJobs,
} = require('../src/jobs/retryWrapper');
const AppError = require('../src/errors/AppError');

describe('Background jobs retry wrapper (#457)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    clearDeadLetterJobs();
  });

  afterEach(() => {
    jest.useRealTimers();
    clearDeadLetterJobs();
  });

  test('succeeds on first try without retrying', async () => {
    const jobFn = jest.fn().mockResolvedValue('success_data');

    const promise = runWithRetry('test_job', jobFn, { maxAttempts: 3 });
    const result = await promise;

    expect(result).toBe('success_data');
    expect(jobFn).toHaveBeenCalledTimes(1);
    expect(getDeadLetterJobs().length).toBe(0);
  });

  test('succeeds after N failures with backoff', async () => {
    let callCount = 0;
    const transientError = new Error('ECONNRESET: socket hang up');
    transientError.code = 'ECONNRESET';

    const jobFn = jest.fn(async () => {
      callCount++;
      if (callCount < 3) {
        throw transientError;
      }
      return 'recovered';
    });

    const promise = runWithRetry('test_job_n_failures', jobFn, {
      maxAttempts: 4,
      initialDelayMs: 500,
      backoffFactor: 2,
      disableJitter: true,
    });

    // Advance through the retries using fake timers
    // Attempt 1 fails -> wait 500ms
    await Promise.resolve(); // allow initial attempt to run
    jest.advanceTimersByTime(500);

    // Attempt 2 fails -> wait 1000ms
    await Promise.resolve();
    jest.advanceTimersByTime(1000);

    // Attempt 3 succeeds
    await Promise.resolve();

    const result = await promise;
    expect(result).toBe('recovered');
    expect(jobFn).toHaveBeenCalledTimes(3);
    expect(getDeadLetterJobs().length).toBe(0);
  });

  test('exhausts retries and is marked failed in dead-letter registry', async () => {
    const networkTimeout = new Error('ETIMEDOUT: connect timeout');
    networkTimeout.code = 'ETIMEDOUT';

    const jobFn = jest.fn().mockRejectedValue(networkTimeout);

    let caughtError = null;
    const promise = runWithRetry('test_exhaust_job', jobFn, {
      maxAttempts: 3,
      initialDelayMs: 200,
      backoffFactor: 2,
      disableJitter: true,
    }).catch((err) => {
      caughtError = err;
    });

    // Attempt 1 fails -> delay 200ms
    await Promise.resolve();
    jest.advanceTimersByTime(200);

    // Attempt 2 fails -> delay 400ms
    await Promise.resolve();
    jest.advanceTimersByTime(400);

    // Attempt 3 fails -> exhausted
    await Promise.resolve();
    await promise;

    expect(caughtError).not.toBeNull();
    expect(caughtError.isExhausted).toBe(true);
    expect(caughtError.attempts).toBe(3);
    expect(jobFn).toHaveBeenCalledTimes(3);

    // Verify it is recorded in the dead-letter list
    const deadLetter = getDeadLetterJobs();
    expect(deadLetter.length).toBe(1);
    expect(deadLetter[0]).toMatchObject({
      jobName: 'test_exhaust_job',
      attempts: 3,
    });
  });

  test('a non-retryable error is not retried and aborts immediately', async () => {
    // Permanent validation error
    const validationError = new AppError('INVALID_INPUT', 'Recipient address invalid', 400);
    const jobFn = jest.fn().mockRejectedValue(validationError);

    await expect(
      runWithRetry('non_retryable_job', jobFn, { maxAttempts: 5 })
    ).rejects.toThrow(validationError);

    // Called only once — did NOT retry
    expect(jobFn).toHaveBeenCalledTimes(1);
    expect(getDeadLetterJobs().length).toBe(0);
  });

  test('TypeError is classified as non-transient bug and not retried', async () => {
    const typeErr = new TypeError('Cannot read property of undefined');
    const jobFn = jest.fn().mockRejectedValue(typeErr);

    await expect(
      runWithRetry('type_error_job', jobFn, { maxAttempts: 3 })
    ).rejects.toThrow(typeErr);

    expect(jobFn).toHaveBeenCalledTimes(1);
  });

  test('transient error detection correctly categorizes errors', () => {
    // Transient
    const connReset = new Error('read ECONNRESET');
    connReset.code = 'ECONNRESET';
    expect(isTransientError(connReset)).toBe(true);

    const http503 = new AppError('SERVICE_UNAVAILABLE', 'Service Unavailable', 503);
    expect(isTransientError(http503)).toBe(true);

    const http429 = new AppError('RATE_LIMITED', 'Rate limit exceeded', 429);
    expect(isTransientError(http429)).toBe(true);

    // Permanent
    const http401 = new AppError('UNAUTHORIZED', 'Invalid key', 401);
    expect(isTransientError(http401)).toBe(false);

    const http404 = new AppError('NOT_FOUND', 'Not found', 404);
    expect(isTransientError(http404)).toBe(false);
  });
});
