'use strict';

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const requestContext = new AsyncLocalStorage();

// X-Request-ID / X-Correlation-ID is an OPTIONAL client hint used to correlate
// a client's own logs with this server's logs. It is NOT authoritative and NOT
// guaranteed unique: a client can send anything, so we only honor values that
// look like a sane correlation ID (alphanumeric plus -/_ and within a modest
// length). Anything else is discarded and a fresh server-generated UUID is used.
const MAX_REQUEST_ID_LENGTH = 128;
const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9_-]+$/;

function isValidRequestId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_REQUEST_ID_LENGTH &&
    SAFE_REQUEST_ID_RE.test(value)
  );
}

function generateCorrelationId() {
  return crypto.randomUUID();
}

function nanoid(size = 21) {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-';
  const bytes = crypto.randomBytes(size);
  let id = '';
  for (const byte of bytes) id += alphabet[byte & 63];
  return id;
}

function getRequestId() {
  const store = requestContext.getStore();
  const requestId = store?.requestId || store?.correlationId;
  return requestId && requestId !== 'system' ? requestId : null;
}

function getRequestIdHeaders() {
  const requestId = getRequestId();
  return requestId ? { 'X-Request-ID': requestId, 'X-Correlation-ID': requestId } : {};
}

function addRequestIdHeaderInterceptor(httpClient) {
  if (!httpClient?.interceptors?.request?.use) return httpClient;
  httpClient.interceptors.request.use((requestConfig) => {
    const requestIdHeaders = getRequestIdHeaders();
    if (Object.keys(requestIdHeaders).length > 0) {
      requestConfig.headers = { ...requestConfig.headers, ...requestIdHeaders };
    }
    return requestConfig;
  });
  return httpClient;
}

function runWithRequestId(requestId, fn) {
  const id = requestId || generateCorrelationId();
  return requestContext.run({ requestId: id, correlationId: id }, fn);
}

function bindRequestId(fn, requestId) {
  const id = requestId || getRequestId() || generateCorrelationId();
  return (...args) => requestContext.run({ requestId: id, correlationId: id }, () => fn(...args));
}

function requestIdMiddleware(req, res, next) {
  const clientHint = req.get('x-request-id') || req.get('x-correlation-id');
  const correlationId = isValidRequestId(clientHint) ? clientHint : generateCorrelationId();

  req.id = correlationId;
  req.correlationId = correlationId;

  res.setHeader('X-Request-ID', correlationId);
  res.setHeader('X-Correlation-ID', correlationId);

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (
      body &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      !Object.prototype.hasOwnProperty.call(body, 'request_id') &&
      !Object.prototype.hasOwnProperty.call(body, 'error')
    ) {
      body.request_id = correlationId;
      if (!Object.prototype.hasOwnProperty.call(body, 'correlation_id')) {
        body.correlation_id = correlationId;
      }
    }
    return originalJson(body);
  };

  requestContext.run({ requestId: correlationId, correlationId }, next);
}

module.exports = {
  requestIdMiddleware,
  requestContext,
  getRequestId,
  getRequestIdHeaders,
  addRequestIdHeaderInterceptor,
  runWithRequestId,
  bindRequestId,
  generateCorrelationId,
  nanoid,
  isValidRequestId,
};
