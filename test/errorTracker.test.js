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
    expect(Sentry.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ extra: expect.objectContaining({ extraInfo: 'test' }) })
    );
  });

  test('captures message when initialized', () => {
    errorTracker.captureMessage('Something went wrong', 'warning', { userId: 123 });
    expect(Sentry.captureMessage).toHaveBeenCalledWith('Something went wrong', {
      level: 'warning',
      extra: { userId: 123 },
    });
  });

  describe('severity levels (#686)', () => {
    test('exposes the supported severity levels in order', () => {
      expect(errorTracker.SEVERITY_LEVELS).toEqual(['info', 'warning', 'error', 'critical']);
    });

    test('classifies 5xx status errors as error and 4xx as warning', () => {
      expect(errorTracker.classifyError({ message: 'boom', status: 503 })).toBe('error');
      expect(errorTracker.classifyError({ message: 'bad', statusCode: 404 })).toBe('warning');
    });

    test('classifies fatal errors as critical', () => {
      expect(errorTracker.classifyError({ name: 'FatalError', message: 'x' })).toBe('critical');
      expect(errorTracker.classifyError({ message: 'x', critical: true })).toBe('critical');
    });

    test('prefers an explicit valid severity and defaults to error otherwise', () => {
      expect(errorTracker.classifyError({ message: 'x', severity: 'info' })).toBe('info');
      expect(errorTracker.classifyError(new Error('plain'))).toBe('error');
      expect(errorTracker.classifyError({ message: 'x', severity: 'bogus' })).toBe('error');
    });

    test('track returns the fingerprint and sends the mapped Sentry level when initialized', () => {
      const err = new Error('Disk full');
      const fingerprint = errorTracker.track({ error: err, severity: 'critical' });
      expect(fingerprint).toBe(errorTracker.hashError(err));
      expect(Sentry.captureException).toHaveBeenCalledWith(
        err,
        expect.objectContaining({ level: 'fatal' })
      );
    });

    test('track returns null when no error is given', () => {
      expect(errorTracker.track({ severity: 'info' })).toBeNull();
    });
  });
});
