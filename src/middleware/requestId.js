'use strict';

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const requestContext = new AsyncLocalStorage();

function requestIdMiddleware(req, res, next) {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-ID', req.id);
  requestContext.run({ requestId: req.id }, next);
}

module.exports = {
  requestIdMiddleware,
  requestContext,
};
