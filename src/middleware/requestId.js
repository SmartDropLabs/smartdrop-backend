'use strict';

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const requestContext = new AsyncLocalStorage();

function nanoid(size = 21) {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-';
  const bytes = crypto.randomBytes(size);
  let id = '';
  for (const byte of bytes) id += alphabet[byte & 63];
  return id;
}

function requestIdMiddleware(req, res, next) {
  req.id = req.get('x-request-id') || `req_${nanoid()}`;
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
};
