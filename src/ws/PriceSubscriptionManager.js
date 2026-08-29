'use strict';

const config = require('../config');
const logger = require('../logger');

const MAX_ASSETS_PER_CLIENT = 5;
const MAX_CONNECTIONS = config.ws.maxConnections;
const MAX_CONNECTIONS_PER_IP = config.ws.maxConnectionsPerIp;
const PING_INTERVAL_MS = 30_000;
const MAX_MISSED_PINGS = 3;
const PRICE_CHANGE_THRESHOLD_PCT = 0.1;

// Prometheus gauge — updated whenever a socket connects or disconnects.
let wsConnectionsGauge = null;
try {
  const prom = require('prom-client');
  wsConnectionsGauge = new prom.Gauge({
    name: 'ws_connections_current',
    help: 'Number of currently active WebSocket connections',
  });
} catch {
  // prom-client not installed; gauge is a no-op.
}

function updateGauge(delta) {
  if (wsConnectionsGauge) wsConnectionsGauge.inc(delta);
}

/**
 * Tracks WebSocket subscriptions and delivers price-change pushes.
 *
 * Each socket entry:
 *   { ws, assets: Set<string>, missedPings: number }
 */
class PriceSubscriptionManager {
  constructor() {
    this._clients = new Map(); // ws → { assets, missedPings }
    this._clientIpBySocket = new Map(); // ws → string
    this._connectionsByIp = new Map(); // ip → number
    this._previousPrices = new Map(); // assetKey → number
    this._pingTimer = null;
    this._draining = false;
    this._drainStats = { warned: 0, closed: 0, forceClosed: 0 };
  }

  _getClientIp(req) {
    const forwardedFor = req?.headers?.['x-forwarded-for'];
    if (Array.isArray(forwardedFor) && forwardedFor.length > 0) {
      return forwardedFor[0].split(',')[0].trim();
    }
    if (typeof forwardedFor === 'string') {
      return forwardedFor.split(',')[0].trim();
    }
    const socket = req?.socket;
    return socket?.remoteAddress || 'unknown';
  }

  /** Register a new WebSocket connection. Returns false when at capacity or draining. */
  add(ws, req = {}) {
    if (this._draining) {
      ws.close(1013, 'Server shutting down');
      return false;
    }

    const clientIp = this._getClientIp(req).replace(/^::ffff:/, '');
    const currentByIp = this._connectionsByIp.get(clientIp) || 0;

    if (this._clients.size >= MAX_CONNECTIONS || currentByIp >= MAX_CONNECTIONS_PER_IP) {
      ws.close(1013, 'Max connections reached');
      return false;
    }

    this._clients.set(ws, { assets: new Set(), missedPings: 0 });
    this._clientIpBySocket.set(ws, clientIp);
    this._connectionsByIp.set(clientIp, currentByIp + 1);
    updateGauge(1);
    logger.info('WS client connected', { ip: clientIp, total: this._clients.size });

    ws.on('message', (raw) => this._handleMessage(ws, raw));
    ws.on('close', () => this._remove(ws));
    ws.on('error', (err) => {
      logger.warn('WS client error', { error: err.message });
      this._remove(ws);
    });

    return true;
  }

  _remove(ws) {
    if (!this._clients.has(ws)) return;
    const clientIp = this._clientIpBySocket.get(ws) || 'unknown';
    this._clients.delete(ws);
    this._clientIpBySocket.delete(ws);
    const nextCount = (this._connectionsByIp.get(clientIp) || 1) - 1;
    if (nextCount <= 0) {
      this._connectionsByIp.delete(clientIp);
    } else {
      this._connectionsByIp.set(clientIp, nextCount);
    }
    updateGauge(-1);
    logger.info('WS client disconnected', { ip: clientIp, total: this._clients.size });
  }

  _handleMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      this._send(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    const client = this._clients.get(ws);
    if (!client) return;

    if (msg.action === 'subscribe') {
      const requested = Array.isArray(msg.assets) ? msg.assets : [];
      // Enforce cumulative cap: only add assets while under the limit (#124).
      const added = [];
      for (const a of requested) {
        if (client.assets.size >= MAX_ASSETS_PER_CLIENT) break;
        const key = String(a);
        if (!client.assets.has(key)) {
          client.assets.add(key);
          added.push(key);
        }
      }
      if (added.length === 0 && client.assets.size >= MAX_ASSETS_PER_CLIENT && requested.length > 0) {
        this._send(ws, { type: 'error', message: `Subscription cap reached (${MAX_ASSETS_PER_CLIENT} max)` });
      } else {
        this._send(ws, { type: 'subscribed', assets: [...client.assets] });
      }

    } else if (msg.action === 'unsubscribe') {
      const toRemove = Array.isArray(msg.assets) ? msg.assets : [];
      for (const a of toRemove) client.assets.delete(String(a));
      this._send(ws, { type: 'unsubscribed', assets: [...client.assets] });

    } else if (msg.action === 'pong') {
      client.missedPings = 0;

    } else {
      this._send(ws, { type: 'error', message: `Unknown action: ${msg.action}` });
    }
  }

  _send(ws, payload) {
    if (ws.readyState !== ws.constructor.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      logger.warn('WS send failed', { error: err.message });
    }
  }

  /**
   * Called after each price refresh cycle with a map of assetKey → newPrice.
   * Pushes updates to subscribers whose watched asset changed by > 0.1%.
   */
  notifyPriceUpdates(freshPrices) {
    for (const [assetKey, { price, source }] of Object.entries(freshPrices)) {
      const prev = this._previousPrices.get(assetKey);

      if (prev !== undefined && prev > 0) {
        const changePct = ((price - prev) / prev) * 100;
        if (Math.abs(changePct) > PRICE_CHANGE_THRESHOLD_PCT) {
          const update = {
            type: 'price_update',
            asset: assetKey,
            price_usd: price,
            previous_price_usd: prev,
            change_pct: parseFloat(changePct.toFixed(4)),
            source,
            timestamp: new Date().toISOString(),
          };
          this._broadcast(assetKey, update);
        }
      }

      this._previousPrices.set(assetKey, price);
    }
  }

  _broadcast(assetKey, payload) {
    for (const [ws, client] of this._clients) {
      if (client.assets.has(assetKey)) {
        this._send(ws, payload);
      }
    }
  }

  /** Start sending heartbeat pings every 30 s; disconnect idle sockets. */
  startHeartbeat() {
    if (this._pingTimer) return;
    this._pingTimer = setInterval(() => {
      for (const [ws, client] of this._clients) {
        if (client.missedPings >= MAX_MISSED_PINGS) {
          logger.info('WS client timed out, disconnecting');
          ws.terminate();
          this._remove(ws);
          continue;
        }
        client.missedPings += 1;
        this._send(ws, { type: 'ping' });
      }
    }, PING_INTERVAL_MS);
  }

  stopHeartbeat() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  /**
   * Gracefully drain all connected clients during server shutdown.
   * Broadcasts a shutdown warning, then sends close frames, and force-closes
   * any connections still open after `drainTimeoutMs` (issue #248).
   */
  drain(drainTimeoutMs = 5000) {
    this.stopHeartbeat();
    this._draining = true;
    const clientCount = this._clients.size;
    if (clientCount === 0) return Promise.resolve();

    this._drainStats = { warned: clientCount, closed: 0, forceClosed: 0 };
    logger.info('Draining WebSocket connections', { count: clientCount, drain_timeout_ms: drainTimeoutMs });

    // Phase 1: Broadcast shutdown warning so clients can prepare
    for (const [ws] of this._clients) {
      try {
        this._send(ws, { type: 'server_shutdown', message: 'Server is shutting down', drain_timeout_ms: drainTimeoutMs });
      } catch {
        // already closed or errored — ignore
      }
    }

    // Phase 2: After a brief grace period for clients to finish in-flight work,
    // send close frames to initiate orderly disconnection
    const closeDelayMs = Math.min(1000, drainTimeoutMs / 2);
    return new Promise((resolve) => {
      const closeTimer = setTimeout(() => {
        for (const [ws] of this._clients) {
          try {
            ws.close(1001, 'Server shutting down');
            this._drainStats.closed++;
          } catch {
            // already closed or errored — ignore
          }
        }
      }, closeDelayMs);

      closeTimer.unref();

      const deadline = setTimeout(() => {
        const remaining = this._clients.size;
        for (const [ws] of this._clients) {
          try { ws.terminate(); } catch { /* ignore */ }
          this._drainStats.forceClosed++;
        }
        this._clients.clear();
        this._clientIpBySocket.clear();
        this._connectionsByIp.clear();
        updateGauge(-clientCount);
        logger.info('WebSocket drain complete', {
          total: clientCount,
          gracefully_closed: this._drainStats.closed,
          force_closed: remaining,
        });
        resolve();
      }, drainTimeoutMs);

      deadline.unref();
    });
  }

  get connectionCount() {
    return this._clients.size;
  }

  get isDraining() {
    return this._draining;
  }

  get drainStats() {
    return { ...this._drainStats };
  }
}

module.exports = new PriceSubscriptionManager();
module.exports.PriceSubscriptionManager = PriceSubscriptionManager;
