'use strict';

/**
 * Machine-readable application error codes (issue #253).
 *
 * Clients switch on `error.code`, never on the human-readable message, so
 * these strings are a public API contract: renaming one is a breaking
 * change for every consumer handling it. Messages can be reworded freely.
 *
 * Each entry carries the HTTP status it maps to, so a throw site normally
 * names only the code and lets the status follow from the registry rather
 * than repeating it (and risking the two drifting apart).
 *
 * Resource-specific codes (WEBHOOK_NOT_FOUND, AIRDROP_NOT_FOUND, …) exist
 * alongside the generic ones because "not found" alone does not tell a
 * client *what* was missing — the point of a machine-readable code is to
 * let it react differently to a missing webhook than to a missing airdrop
 * without parsing prose.
 */
const ERROR_CODES = Object.freeze({
  // ── Generic ──────────────────────────────────────────────────────────
  VALIDATION_ERROR: { statusCode: 400 },
  UNAUTHORIZED: { statusCode: 401 },
  FORBIDDEN: { statusCode: 403 },
  NOT_FOUND: { statusCode: 404 },
  CONFLICT: { statusCode: 409 },
  PAYLOAD_TOO_LARGE: { statusCode: 413 },
  UNSUPPORTED_MEDIA_TYPE: { statusCode: 415 },
  RATE_LIMITED: { statusCode: 429 },
  INTERNAL_ERROR: { statusCode: 500 },
  UPSTREAM_ERROR: { statusCode: 502 },
  SERVICE_UNAVAILABLE: { statusCode: 503 },

  // ── Airdrops ─────────────────────────────────────────────────────────
  AIRDROP_NOT_FOUND: { statusCode: 404 },
  AIRDROP_NOT_INDEXED: { statusCode: 404 },
  RECIPIENT_LIMIT_EXCEEDED: { statusCode: 400 },
  CSV_INVALID_ENCODING: { statusCode: 400 },
  CSV_MISSING_COLUMNS: { statusCode: 400 },
  CSV_MALFORMED: { statusCode: 400 },
  CSV_EMPTY: { statusCode: 400 },

  // ── Webhooks ─────────────────────────────────────────────────────────
  WEBHOOK_NOT_FOUND: { statusCode: 404 },
  WEBHOOK_LIMIT_EXCEEDED: { statusCode: 429 },

  // ── Alerts ───────────────────────────────────────────────────────────
  ALERT_NOT_FOUND: { statusCode: 404 },

  // ── API keys ─────────────────────────────────────────────────────────
  API_KEY_NOT_FOUND: { statusCode: 404 },

  // ── Prices / upstream data sources ───────────────────────────────────
  PRICE_UNAVAILABLE: { statusCode: 503 },

  // ── Indexer ──────────────────────────────────────────────────────────
  INDEXER_UNAVAILABLE: { statusCode: 503 },
});

class AppError extends Error {
  constructor(code, message, statusCode, details = {}) {
    super(message);
    if (!ERROR_CODES[code]) {
      throw new Error(`Unknown application error code: ${code}`);
    }
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode || ERROR_CODES[code].statusCode;
    this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }
}

AppError.codes = ERROR_CODES;

/** True when `code` is a registered application error code. */
AppError.isKnownCode = function isKnownCode(code) {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, code);
};

module.exports = AppError;
