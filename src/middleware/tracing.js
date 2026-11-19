'use strict';

/**
 * Distributed tracing middleware (#492).
 *
 * Adds trace context headers to responses and propagates trace IDs
 * across service boundaries via the `traceparent` header (W3C Trace Context).
 *
 * For full OpenTelemetry integration, install `@opentelemetry/sdk-node`
 * and `@opentelemetry/instrumentation-http` and configure the SDK in
 * your entrypoint. This middleware provides the lightweight trace
 * propagation layer for services that don't need the full OTel SDK.
 */

const crypto = require('crypto');

const TRACE_HEADER = 'traceparent';
const TRACE_RESPONSE_HEADER = 'x-trace-id';

function parseTraceparent(header) {
  if (!header) return null;
  // Format: 00-<32 hex trace_id>-<16 hex parent_id>-<2 hex flags>
  const parts = header.split('-');
  if (parts.length !== 4) return null;
  const [version, traceId, parentId, flags] = parts;
  if (version !== '00') return null;
  return { traceId, parentId, flags };
}

function generateTraceId() {
  return crypto.randomBytes(16).toString('hex');
}

function generateSpanId() {
  return crypto.randomBytes(8).toString('hex');
}

function buildTraceparent(traceId, spanId, flags = '01') {
  return `00-${traceId}-${spanId}-${flags}`;
}

function tracingMiddleware(req, res, next) {
  // Parse incoming trace context or create a new one
  const incoming = parseTraceparent(req.headers[TRACE_HEADER]);
  const traceId = incoming?.traceId ?? generateTraceId();
  const spanId = generateSpanId();

  // Attach to request for downstream use
  req.traceId = traceId;
  req.spanId = spanId;
  req.traceparent = buildTraceparent(traceId, spanId);

  // Propagate trace context on outbound responses
  res.setHeader(TRACE_HEADER, req.traceparent);
  res.setHeader(TRACE_RESPONSE_HEADER, traceId);

  // Propagate trace context on outbound requests (if using fetch/axios)
  if (!req.headers[TRACE_HEADER]) {
    req.headers[TRACE_HEADER] = req.traceparent;
  }

  next();
}

module.exports = {
  tracingMiddleware,
  parseTraceparent,
  buildTraceparent,
  generateTraceId,
  generateSpanId,
};
