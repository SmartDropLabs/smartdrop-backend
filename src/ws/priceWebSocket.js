'use strict';

const { WebSocketServer } = require('ws');
const logger = require('../logger');
const apiKeys = require('../services/apiKeys');
const subscriptionManager = require('./PriceSubscriptionManager');

function extractBearerToken(header) {
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function authenticateUpgrade(info, callback) {
  const token = extractBearerToken(info.req.headers.authorization);
  if (!token) {
    callback(false, 401, 'Missing or invalid API key');
    return;
  }

  apiKeys.validateApiKey(token)
    .then((apiKey) => {
      if (!apiKey) {
        callback(false, 401, 'Missing or invalid API key');
        return;
      }
      callback(true);
    })
    .catch((err) => {
      logger.warn('WebSocket authentication failed', { error: err.message });
      callback(false, 401, 'Missing or invalid API key');
    });
}

/**
 * Attach the WebSocket server to an existing HTTP server.
 * Clients connect at ws://<host>/ws
 */
function attach(httpServer) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    verifyClient: authenticateUpgrade,
  });

  wss.on('connection', (ws, req) => {
    logger.info('Incoming WS connection', { ip: req.socket.remoteAddress });
    subscriptionManager.add(ws, req);
  });

  wss.on('error', (err) => {
    logger.error('WebSocket server error', { error: err.message });
  });

  subscriptionManager.startHeartbeat();
  logger.info('WebSocket price-stream server attached at /ws');

  return wss;
}

module.exports = { attach };
