'use strict';

/**
 * Shared UTC date helpers (issue #494).
 *
 * The project standard is: every instant is created, compared and stored in
 * UTC, and serialized in API responses as an ISO-8601 string with a `Z`
 * suffix. Local time is only ever produced at presentation time, by a client,
 * from one of these UTC values — never by the server.
 *
 * These helpers exist so the rule is enforced in one place instead of being
 * re-spelled (and occasionally forgotten) at each call site:
 *
 *   - `nowIso()` and `toIso()` always emit `...Z`, regardless of the host's
 *     time zone or of whether the input was a Date, an epoch number, or a
 *     string with or without an offset.
 *   - `startOfUtcDay()` / `utcDayKey()` make "today" and day-boundary logic
 *     explicit in UTC. A date-only string like `2026-01-01` is parsed by
 *     JavaScript as UTC midnight, but the *local* date at that instant is
 *     still 2025-12-31 for a server in UTC-5; bucketing on day boundaries must
 *     therefore use `utcDayKey()` rather than slicing a local-time string.
 *   - `assertUtcTimeZone()` is a defensive default for the process (`TZ=UTC`
 *     when the operator has not set one). It is deliberately NOT the fix for
 *     time-zone bugs: it only guarantees a stable default, and every helper
 *     above remains correct when it is removed or overridden. See
 *     README.md#time-handling.
 *
 * No date library is used — `Date` plus `Date.UTC` is sufficient for the
 * operations the codebase needs, and the repo does not depend on one.
 */

/**
 * Current time as an ISO-8601 UTC string (`2026-01-01T00:00:00.000Z`).
 *
 * @returns {string}
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Normalize any date-like value to an ISO-8601 UTC string.
 *
 * Accepts a `Date`, an epoch-millisecond number, or any string `Date` can
 * parse (with or without an offset). Returns `null` for empty or unparsable
 * input so callers can store an explicit `null` rather than "Invalid Date".
 *
 * @param {Date|number|string|null|undefined} value
 * @returns {string|null}
 */
function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * The UTC midnight that starts the UTC day containing `value`.
 *
 * Uses `getUTC*`/`Date.UTC` explicitly, so it returns the same instant no
 * matter what the host's local time zone is.
 *
 * @param {Date|number|string} [value]
 * @returns {Date|null}
 */
function startOfUtcDay(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * The `YYYY-MM-DD` UTC day key for `value` — the only correct way to bucket a
 * timestamp into a calendar day on the server.
 *
 * @param {Date|number|string} [value]
 * @returns {string|null}
 */
function utcDayKey(value = new Date()) {
  const start = startOfUtcDay(value);
  return start ? start.toISOString().slice(0, 10) : null;
}

const UTC_ALIASES = new Set(['UTC', 'Etc/UTC', 'Etc/Greenwich', 'GMT']);

/**
 * Ensure the process has a stable time-zone default.
 *
 * When `TZ` is unset, sets it to `UTC`. When it is set to a non-UTC zone the
 * value is left untouched (an operator opted in explicitly) but reported so
 * the caller can log it — the code must stay correct either way, because the
 * setting is only a default and is lost the moment the code runs somewhere
 * else (a worker, a migration, a one-off script).
 *
 * @param {Object} [options]
 * @param {NodeJS.ProcessEnv} [options.env=process.env]
 * @returns {{ changed: boolean, timeZone: string, isNonUtc: boolean }}
 */
function assertUtcTimeZone({ env = process.env } = {}) {
  if (!env.TZ) {
    env.TZ = 'UTC';
    return { changed: true, timeZone: 'UTC', isNonUtc: false };
  }
  return { changed: false, timeZone: env.TZ, isNonUtc: !UTC_ALIASES.has(env.TZ) };
}

module.exports = {
  assertUtcTimeZone,
  nowIso,
  startOfUtcDay,
  toIso,
  utcDayKey,
};
