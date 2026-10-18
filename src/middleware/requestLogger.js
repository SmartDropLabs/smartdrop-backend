"use strict";

/**
 * Structured logging for every HTTP request/response cycle (issue #148).
 *
 * Complements `routes/metrics.js`'s `requestMetricsMiddleware` (which only
 * increments in-memory counters) with an actual log line per request —
 * method, path, status code, and duration — so requests are debuggable and
 * analyzable outside of the /metrics snapshot. `req.id`/requestId is already
 * attached to every log line automatically by `logger.js`'s AsyncLocalStorage
 * context (see requestId.js), so it isn't repeated here explicitly.
 *
 * Uses the mount path plus `req.path` (not `req.originalUrl`) so mounted
 * routers are logged accurately without exposing query strings, which can
 * carry API keys on some endpoints.
 *
 * Also emits a distinct "Slow request detected" warn-level line for any
 * request over SLOW_REQUEST_THRESHOLD_MS (default 1s, issue #244), so slow
 * requests are greppable/alertable on their own rather than mixed in with
 * every other normal-speed request at 'info' level.
 */

const logger = require("../logger");
const config = require("../config");
const { redactInfo } = require("../services/logRedaction");

const MAX_LOGGED_BODY_CHARS = 4096;

function requestBodyForLog(req) {
  if (!req.body || typeof req.body !== "object") return undefined;
  if (String(req.headers["content-type"] || "").startsWith("multipart/")) {
    return undefined;
  }

  try {
    const sanitized = redactInfo({ requestPayload: req.body }).requestPayload;
    const serialized = JSON.stringify(sanitized);
    if (serialized.length > MAX_LOGGED_BODY_CHARS) {
      return { truncated: true, preview: serialized.slice(0, MAX_LOGGED_BODY_CHARS) };
    }
    return sanitized;
  } catch {
    return undefined;
  }
}

function requestLoggerMiddleware(req, res, next) {
  const startedAt = process.hrtime.bigint();
  const requestPath = req.baseUrl + req.path;

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const roundedDurationMs = Math.round(durationMs * 100) / 100;
    const level =
      res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";

    const correlationId = req.id || req.correlationId;
    const requestPayload = requestBodyForLog(req);

    logger[level]("HTTP request", {
      method: req.method,
      path: requestPath,
      statusCode: res.statusCode,
      status: res.statusCode,
      durationMs: roundedDurationMs,
      duration: roundedDurationMs,
      correlationId,
      correlation_id: correlationId,
      requestId: correlationId,
      request_id: correlationId,
      ...(requestPayload ? { request_payload: requestPayload } : {}),
    });

    // Distinct, greppable/alertable warning for slow requests (issue #244),
    // in addition to the routine log line above — a slow-but-successful
    // (2xx) request would otherwise only ever appear at 'info' level mixed
    // in with every other normal request.
    if (durationMs > config.slowRequestThresholdMs) {
      logger.warn("Slow request detected", {
        method: req.method,
        path: requestPath,
        statusCode: res.statusCode,
        status: res.statusCode,
        durationMs: roundedDurationMs,
        duration: roundedDurationMs,
        thresholdMs: config.slowRequestThresholdMs,
        correlationId,
        correlation_id: correlationId,
        requestId: correlationId,
        request_id: correlationId,
      });
    }
  });

  next();
}

module.exports = requestLoggerMiddleware;
