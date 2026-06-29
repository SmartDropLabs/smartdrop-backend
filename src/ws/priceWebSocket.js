'use strict';

const { WebSocketServer } = require('ws');
const logger = require('../logger');
const subscriptionManager = require('./PriceSubscriptionManager');

/**
 * Attach the WebSocket server to an existing HTTP server.
 * Clients connect at ws://<host>/ws
 */
function attach(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    logger.info('Incoming WS connection', { ip: req.socket.remoteAddress });
    subscriptionManager.add(ws);
  });

  wss.on('error', (err) => {
    logger.error('WebSocket server error', { error: err.message });
  });

  subscriptionManager.startHeartbeat();
  logger.info('WebSocket price-stream server attached at /ws');

  return wss;
}

module.exports = { attach };
