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

function getClientIp(req) {
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (xForwardedFor) {
    return xForwardedFor.split(',')[0].trim();
  }
  return req.socket.remoteAddress;
}

async function authenticateUpgrade(info) {
  const token = extractBearerToken(info.req.headers.authorization);
  if (!token) {
    return false;
  }

  try {
    const apiKey = await apiKeys.validateApiKey(token);
    if (!apiKey) {
      return false;
    }
    return true;
  } catch (err) {
    logger.warn('WebSocket authentication failed', { error: err.message });
    return false;
  }
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
    logger.info('Incoming WS connection', { ip: getClientIp(req) });
    subscriptionManager.add(ws, req);
  });

  wss.on('error', (err) => {
    logger.error('WebSocket server error', { error: err.message });
  });

  subscriptionManager.startHeartbeat();
  logger.info('WebSocket price-stream server attached at /ws');

  return wss;
}

/**
 * Gracefully close all WebSocket connections and stop the heartbeat.
 * Call this during process shutdown to avoid abrupt connection drops.
 */
async function shutdown(wss, drainTimeoutMs = 5000) {
  if (!wss) return;

  await subscriptionManager.drain(drainTimeoutMs);

  await new Promise((resolve) => {
    wss.close(() => {
      logger.info('WebSocket server closed');
      resolve();
    });
  });
}

module.exports = { attach, shutdown };
