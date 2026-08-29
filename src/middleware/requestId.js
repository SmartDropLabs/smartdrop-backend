'use strict';

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const requestContext = new AsyncLocalStorage();

// X-Request-ID is an OPTIONAL client hint used to correlate a client's own logs
// with this server's logs. It is NOT authoritative and NOT guaranteed unique:
// a client can send anything, so we only honor values that look like a sane
// correlation ID (alphanumeric plus -/_ and within a modest length). Anything
// else is discarded and a fresh server-generated ID is used instead. See #133.
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

function nanoid(size = 21) {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-';
  const bytes = crypto.randomBytes(size);
  let id = '';
  for (const byte of bytes) id += alphabet[byte & 63];
  return id;
}

function requestIdMiddleware(req, res, next) {
  const clientId = req.get('x-request-id');
  req.id = isValidRequestId(clientId) ? clientId : `req_${nanoid()}`;
  res.setHeader('X-Request-ID', req.id);

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (
      body &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      !Object.prototype.hasOwnProperty.call(body, 'request_id') &&
      !Object.prototype.hasOwnProperty.call(body, 'error')
    ) {
      body.request_id = req.id;
    }
    return originalJson(body);
  };

  requestContext.run({ requestId: req.id }, next);
}

module.exports = {
  requestIdMiddleware,
  requestContext,
  nanoid,
  isValidRequestId,
};
