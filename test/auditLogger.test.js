'use strict';

/**
 * Audit log rotation (#620) — the dedicated audit file is rotated daily and
 * by size, with a bounded retention, so it can never grow without limit.
 */

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const logger = require('../src/logger');
const { AuditLogger, auditRotationOptions } = require('../src/middleware/auditLogger');

describe('auditRotationOptions (#620)', () => {
  test('is disabled when no log directory is configured', () => {
    expect(auditRotationOptions({})).toBeNull();
  });

  test('rotates daily and by size with a bounded retention by default', () => {
    expect(auditRotationOptions({ AUDIT_LOG_DIR: '/var/log/smartdrop' })).toEqual({
      filename: '/var/log/smartdrop/audit-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      utc: true,
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '90d',
    });
  });

  test('falls back to LOG_FILE_PATH and honours size and retention overrides', () => {
    const options = auditRotationOptions({
      LOG_FILE_PATH: '/logs',
      AUDIT_LOG_MAX_SIZE: '50m',
      AUDIT_LOG_RETENTION: '365d',
    });
    expect(options.filename).toBe('/logs/audit-%DATE%.log');
    expect(options.maxSize).toBe('50m');
    expect(options.maxFiles).toBe('365d');
  });
});

describe('AuditLogger.log', () => {
  test('still writes every admin action to the main logger', () => {
    AuditLogger.log({ admin: 'u1', action: 'delete_webhook', resource: 'webhook:1' });

    expect(logger.info).toHaveBeenCalledWith(
      '[AUDIT]',
      expect.objectContaining({
        type: 'admin_action',
        admin: 'u1',
        action: 'delete_webhook',
        resource: 'webhook:1',
        result: 'success',
      }),
    );
  });
});
