'use strict';

const logger = require('../logger');

const MAX_ASSETS_PER_CLIENT = 5;
const MAX_CONNECTIONS = 100;
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
    this._previousPrices = new Map(); // assetKey → number
    this._pingTimer = null;
  }

  /** Register a new WebSocket connection. Returns false when at capacity. */
  add(ws) {
    if (this._clients.size >= MAX_CONNECTIONS) {
      ws.close(1013, 'Max connections reached');
      return false;
    }

    this._clients.set(ws, { assets: new Set(), missedPings: 0 });
    updateGauge(1);
    logger.info('WS client connected', { total: this._clients.size });

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
    this._clients.delete(ws);
    updateGauge(-1);
    logger.info('WS client disconnected', { total: this._clients.size });
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
      const allowed = requested.slice(0, MAX_ASSETS_PER_CLIENT);
      for (const a of allowed) client.assets.add(String(a));
      this._send(ws, { type: 'subscribed', assets: [...client.assets] });

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

  get connectionCount() {
    return this._clients.size;
  }
}

module.exports = new PriceSubscriptionManager();
module.exports.PriceSubscriptionManager = PriceSubscriptionManager;
