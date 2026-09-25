'use strict';

/**
 * Startup banner with version and config summary (issue #236).
 */

const { createCacheMock } = require('./helpers/cacheMock');

const mockHelper = createCacheMock();
jest.mock('../src/services/cache', () => mockHelper.cacheMock);

const mockLogger = {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
};
jest.mock('../src/logger', () => mockLogger);

const { logStartupBanner, sanitizeUrl } = require('../src/index');
const config = require('../src/config');
const { version: appVersion } = require('../package.json');

beforeEach(() => {
  Object.values(mockLogger).forEach((fn) => fn.mockClear());
});

describe('sanitizeUrl', () => {
  test('redacts the password from a connection URL', () => {
    expect(sanitizeUrl('redis://admin:hunter2@redis.internal:6379'))
      .not.toContain('hunter2');
  });

  test('redacts the username as well', () => {
    expect(sanitizeUrl('postgres://smartdrop:secret@db:5432/smartdrop'))
      .not.toContain('smartdrop:secret');
  });

  test('keeps host, port, and path so the target is still identifiable', () => {
    const sanitized = sanitizeUrl('postgres://user:pw@db.internal:5432/smartdrop');

    expect(sanitized).toContain('db.internal');
    expect(sanitized).toContain('5432');
    expect(sanitized).toContain('smartdrop');
  });

  test('passes credential-free URLs through unchanged in substance', () => {
    expect(sanitizeUrl('redis://localhost:6379')).toContain('localhost:6379');
  });

  test('returns null when no URL is configured', () => {
    expect(sanitizeUrl(undefined)).toBeNull();
    expect(sanitizeUrl('')).toBeNull();
  });

  test('never returns an unparseable value verbatim', () => {
    expect(sanitizeUrl('not a url at all')).toBe('[unparseable]');
  });
});

describe('startup banner', () => {
  test('logs app version, Node version, sanitized Redis URL, and watched asset count', () => {
    logStartupBanner();

    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    const [message, meta] = mockLogger.info.mock.calls[0];

    expect(message).toContain(String(config.port));
    expect(meta).toEqual(expect.objectContaining({
      app_version: appVersion,
      node_version: process.version,
      node_env: config.nodeEnv,
      port: config.port,
      watched_assets_count: config.watchedAssets.length,
    }));
    expect(meta.redis_url).toContain('redis');
  });

  test('never logs Redis or database credentials', () => {
    process.env.DATABASE_URL = 'postgres://dbuser:dbpassword@db:5432/smartdrop';

    logStartupBanner();

    const [, meta] = mockLogger.info.mock.calls[0];
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain('dbpassword');
    expect(serialized).not.toContain('dbuser');
  });
});
