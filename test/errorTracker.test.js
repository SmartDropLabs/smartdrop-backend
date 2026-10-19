'use strict';

const Sentry = require('@sentry/node');
const errorTracker = require('../src/services/errorTracker');

jest.mock('@sentry/node', () => ({
  init: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

describe('errorTracker service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('does not initialize Sentry if DSN is not provided', () => {
    const isInit = errorTracker.init();
    expect(isInit).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  test('does not capture exception if not initialized', () => {
    const err = new Error('Test error');
    const result = errorTracker.captureException(err);
    expect(result).toBeNull();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('initializes Sentry when DSN is set', () => {
    process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
    const config = require('../src/config');
    config.sentryDsn = process.env.SENTRY_DSN;

    const isInit = errorTracker.init();
    expect(isInit).toBe(true);
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: process.env.SENTRY_DSN,
      })
    );
  });

  test('captures exception when initialized', () => {
    const err = new Error('Database error');
    errorTracker.captureException(err, { extraInfo: 'test' });
    expect(Sentry.captureException).toHaveBeenCalledWith(err, { extra: { extraInfo: 'test' } });
  });

  test('captures message when initialized', () => {
    errorTracker.captureMessage('Something went wrong', 'warning', { userId: 123 });
    expect(Sentry.captureMessage).toHaveBeenCalledWith('Something went wrong', {
      level: 'warning',
      extra: { userId: 123 },
    });
  });
});
