'use strict';

/**
 * Time zone handling (issue #494).
 *
 * The project standard is: all instants are created, computed, compared and
 * stored in UTC, and serialized in API responses as ISO-8601 strings with a
 * `Z` suffix. Local time is produced only by a client, from a UTC value.
 *
 * These tests run the same code under several process time zones. Two are
 * used rather than one so that a helper that accidentally reads local time
 * cannot pass by matching the host default:
 *   TZ=UTC              (the standard)
 *   TZ=America/New_York (UTC-4/-5, "behind" UTC)
 *   TZ=Asia/Tokyo       (UTC+9, "ahead" of UTC)
 *
 * A child process is used for the TZ matrix because Node reads TZ when it
 * initializes; spawning with the variable in `env` is the only way to be sure
 * the value is in effect for the code under test.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const TIME_ZONES = ['UTC', 'America/New_York', 'Asia/Tokyo'];

function runInTimeZone(tz, script) {
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      Path: process.env.Path,
      SystemRoot: process.env.SystemRoot,
      COMSPEC: process.env.COMSPEC,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      NODE_ENV: 'test',
      TZ: tz,
    },
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(`child for TZ=${tz} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim());
}

describe('UTC date helpers (issue #494)', () => {
  // A fixed instant whose UTC date differs from the local date in both
  // non-UTC zones chosen above (19:00Z is already the next day in Tokyo, and
  // still the same day but a different wall-clock hour in New York), so a
  // helper that leaked local time would not produce identical values.
  const FIXED_INSTANT = '2026-06-30T19:00:00.000Z';

  test('produce byte-identical output in UTC, America/New_York and Asia/Tokyo', () => {
    const script = `
      const dates = require('./src/utils/dates');
      const fixed = ${JSON.stringify(FIXED_INSTANT)};
      console.log(JSON.stringify({
        toIso: dates.toIso(fixed),
        toIsoEpoch: dates.toIso(Date.parse(fixed)),
        startOfUtcDay: dates.startOfUtcDay(fixed).toISOString(),
        utcDayKey: dates.utcDayKey(fixed),
      }));
    `;

    const results = TIME_ZONES.map((tz) => runInTimeZone(tz, script));

    // Every TZ yields the same (UTC) answers...
    for (const result of results) {
      expect(result).toEqual(results[0]);
    }
    // ...and those answers are the UTC ones, not merely consistent.
    expect(results[0]).toEqual({
      toIso: FIXED_INSTANT,
      toIsoEpoch: FIXED_INSTANT,
      startOfUtcDay: '2026-06-30T00:00:00.000Z',
      utcDayKey: '2026-06-30',
    });
  });

  test('utcDayKey bucketing is stable where a local date would drift', () => {
    // Proof of the class of bug this guards against: JavaScript parses a
    // date-time string WITHOUT an offset in the process's local zone, so the
    // same source string denotes different instants (and different calendar
    // days) depending on the host. The UTC helper is immune.
    const script = `
      const dates = require('./src/utils/dates');
      const naiveLocal = new Date('2026-01-01T00:00:00');
      console.log(JSON.stringify({
        naiveLocalIso: naiveLocal.toISOString(),
        utcDayKey: dates.utcDayKey(naiveLocal),
        // The raw UTC calendar day the instant falls in, for comparison.
        naiveLocalUtcDate: naiveLocal.toISOString().slice(0, 10),
      }));
    `;

    const utc = runInTimeZone('UTC', script);
    const tokyo = runInTimeZone('Asia/Tokyo', script);
    const newYork = runInTimeZone('America/New_York', script);

    // Same source string, three different instants — this is the hazard.
    expect(utc.naiveLocalIso).toBe('2026-01-01T00:00:00.000Z');
    expect(tokyo.naiveLocalIso).toBe('2025-12-31T15:00:00.000Z');
    expect(newYork.naiveLocalIso).toBe('2026-01-01T05:00:00.000Z');

    // utcDayKey always reports the UTC calendar day of the actual instant,
    // so it can never disagree with the stored timestamp's own date prefix.
    for (const result of [utc, tokyo, newYork]) {
      expect(result.utcDayKey).toBe(result.naiveLocalUtcDate);
    }
    expect(tokyo.utcDayKey).toBe('2025-12-31');
  });

  test('toIso returns null for empty and unparsable input rather than "Invalid Date"', () => {
    const dates = require('../src/utils/dates');
    expect(dates.toIso(null)).toBeNull();
    expect(dates.toIso(undefined)).toBeNull();
    expect(dates.toIso('')).toBeNull();
    expect(dates.toIso('not a date')).toBeNull();
  });

  test('toIso normalizes an offset-bearing string to the same UTC instant', () => {
    const dates = require('../src/utils/dates');
    expect(dates.toIso('2026-06-30T12:00:00-04:00')).toBe('2026-06-30T16:00:00.000Z');
  });
});

describe('assertUtcTimeZone (issue #494)', () => {
  const dates = require('../src/utils/dates');

  test('sets TZ=UTC when the process has no explicit time zone', () => {
    const env = {};
    const state = dates.assertUtcTimeZone({ env });

    expect(state).toEqual({ changed: true, timeZone: 'UTC', isNonUtc: false });
    expect(env.TZ).toBe('UTC');
  });

  test('leaves UTC aliases of UTC alone', () => {
    for (const tz of ['UTC', 'Etc/UTC']) {
      const env = { TZ: tz };
      const state = dates.assertUtcTimeZone({ env });
      expect(state).toEqual({ changed: false, timeZone: tz, isNonUtc: false });
      expect(env.TZ).toBe(tz);
    }
  });

  test('reports, but does not rewrite, an explicit non-UTC time zone', () => {
    const env = { TZ: 'Asia/Tokyo' };
    const state = dates.assertUtcTimeZone({ env });

    expect(state).toEqual({ changed: false, timeZone: 'Asia/Tokyo', isNonUtc: true });
    expect(env.TZ).toBe('Asia/Tokyo');
  });
});

describe('PostgreSQL sessions are pinned to UTC (issue #494)', () => {
  test('the pool connection hook sets the session TimeZone to UTC', async () => {
    const { afterCreateUtcConnection } = require('../src/database');
    const queries = [];
    const conn = {
      query: (sql, cb) => {
        queries.push(sql);
        cb(null);
      },
    };

    await new Promise((resolve, reject) => {
      afterCreateUtcConnection(conn, (err, returned) => {
        if (err) return reject(err);
        expect(returned).toBe(conn);
        resolve();
      });
    });

    expect(queries).toEqual(["SET TIME ZONE 'UTC'"]);
  });

  test('a failed statement still releases the connection with the error', async () => {
    const { afterCreateUtcConnection } = require('../src/database');
    const failure = new Error('boom');
    const conn = { query: (_sql, cb) => cb(failure) };

    await new Promise((resolve) => {
      afterCreateUtcConnection(conn, (err) => {
        expect(err).toBe(failure);
        resolve();
      });
    });
  });
});

describe('api key audit timestamps are UTC ISO-8601 (issue #494)', () => {
  test('created_at is serialized with a Z suffix', async () => {
    const apiKeyAuditLog = require('../src/services/apiKeyAuditLog');
    let captured = null;
    const fakeTrx = () => ({
      insert: async (row) => {
        captured = row;
      },
    });

    await apiKeyAuditLog.logUsage(
      { keyId: 'key_1', endpoint: 'GET /v1/prices', ipAddress: '127.0.0.1', statusCode: 200, responseTimeMs: 3 },
      fakeTrx,
    );

    expect(captured.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('log rotation is date-bucketed in UTC (issue #494)', () => {
  // winston-daily-rotate-file resolves %DATE% from the host wall clock by
  // default. Before this change, two servers in different time zones named
  // the same UTC log window differently (Asia/Tokyo put 2026-06-30T19:00Z in
  // a file named ...-07-01.log). The transport now requests UTC filenames.
  test('the file transport requests UTC-dated filenames', () => {
    process.env.LOG_FILE_PATH = '/tmp/smartdrop-test-logs';
    jest.resetModules();

    const logger = require('../src/logger');
    const fileTransport = logger.transports.find(
      (t) => t.filename && String(t.filename).includes('%DATE%'),
    );

    expect(fileTransport).toBeDefined();
    expect(fileTransport.utc ?? fileTransport.options?.utc).toBe(true);

    delete process.env.LOG_FILE_PATH;
    jest.resetModules();
  });

  test('no file transport is created when LOG_FILE_PATH is unset', () => {
    delete process.env.LOG_FILE_PATH;
    jest.resetModules();

    const logger = require('../src/logger');
    const fileTransport = logger.transports.find(
      (t) => t.filename && String(t.filename).includes('%DATE%'),
    );

    expect(fileTransport).toBeUndefined();
  });
});
