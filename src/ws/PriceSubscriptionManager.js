const WebSocket = require("ws");
const config = require("../config");
const logger = require("../logger");
const priceOracle = require("../services/priceOracle");

const MAX_ASSETS_PER_CLIENT = 20;
const MAX_MESSAGE_BYTES = 4096;
const VALID_ASSET_RE = /^[A-Z0-9]{1,12}$/;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_MISSED_PINGS = 2;
const DEFAULT_MAX_CONNECTIONS_PER_IP = 10;

class PriceSubscriptionManager {
  constructor(options = {}) {
    this._clients = new Map();
    this._assetSubscribers = new Map();
    this._previousPrices = new Map();
    this._clientIpBySocket = new Map();
    this._connectionsByIp = new Map();
    this._pollTimer = null;
    this._heartbeatTimer = null;
    this._draining = false;
    this._oracle = options.oracle || priceOracle;
    this._pollIntervalMs = options.pollIntervalMs || config.wsPricePollIntervalMs || 15_000;
    this._heartbeatIntervalMs = options.heartbeatIntervalMs || HEARTBEAT_INTERVAL_MS;
    this._maxConnectionsPerIp =
      options.maxConnectionsPerIp ?? config.ws?.maxConnectionsPerIp ?? DEFAULT_MAX_CONNECTIONS_PER_IP;
  }

  get clientCount() {
    return this._clients.size;
  }

  get trackedAssets() {
    return Array.from(this._assetSubscribers.keys());
  }

  start() {
    if (this._pollTimer) return;
    this._draining = false;

    this._pollTimer = setInterval(() => {
      this._pollAndBroadcast().catch((err) => {
        logger.error("WS price poll failed", { error: err.message });
      });
    }, this._pollIntervalMs);
    this._pollTimer.unref?.();

    this._heartbeatTimer = setInterval(() => {
      this._heartbeat();
    }, this._heartbeatIntervalMs);
    this._heartbeatTimer.unref?.();

    logger.info("PriceSubscriptionManager started", {
      pollIntervalMs: this._pollIntervalMs,
    });
  }

  stop() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    logger.info("PriceSubscriptionManager stopped");
  }

  async shutdown() {
    this._draining = true;
    this.stop();

    const closePromises = [];
    for (const [ws] of Array.from(this._clients.entries())) {
      closePromises.push(
        new Promise((resolve) => {
          const timer = setTimeout(() => {
            try {
              ws.terminate?.();
            } catch {
              // ignore termination errors
            }
            this._remove(ws);
            resolve();
          }, 3000);
          timer.unref?.();

          ws.once?.("close", () => {
            clearTimeout(timer);
            this._remove(ws);
            resolve();
          });

          if (ws.readyState === WebSocket.OPEN) {
            ws.close(1001, "Server shutting down");
          } else {
            clearTimeout(timer);
            try {
              ws.terminate?.();
            } catch {
              // ignore termination errors
            }
            this._remove(ws);
            resolve();
          }
        })
      );
    }

    await Promise.all(closePromises);
    this._clients.clear();
    this._assetSubscribers.clear();
    this._previousPrices.clear();
    this._clientIpBySocket.clear();
    this._connectionsByIp.clear();
    logger.info("All WebSocket connections closed");
  }

  add(ws, req = null) {
    if (this._draining) {
      ws.close(1001, "Server is shutting down");
      return false;
    }

    const clientIp = this._extractClientIp(ws, req);
    const activeForIp = this._connectionsByIp.get(clientIp) || 0;
    if (activeForIp >= this._maxConnectionsPerIp) {
      logger.warn("WS connection rejected: per-IP limit exceeded", {
        ip: clientIp,
        activeConnections: activeForIp,
        maxConnectionsPerIp: this._maxConnectionsPerIp,
      });
      this._send(ws, {
        type: "error",
        code: "TOO_MANY_CONNECTIONS",
        message: `Maximum ${this._maxConnectionsPerIp} concurrent WebSocket connections per IP exceeded`,
      });
      ws.close(1008, "Too many connections from this IP");
      return false;
    }

    const onMessage = (raw) => this._onMessage(ws, raw);
    const onClose = () => this._remove(ws);
    const onError = (err) => {
      logger.warn("WS client error", { error: err.message });
      this._remove(ws);
    };
    const onPong = () => {
      const entry = this._clients.get(ws);
      if (entry) entry.missedPings = 0;
    };
    const rawSocket = req?.socket || ws?._socket || null;
    const onSocketClose = () => this._remove(ws);

    this._clients.set(ws, {
      assets: new Set(),
      missedPings: 0,
      listeners: { onMessage, onClose, onError, onPong, rawSocket, onSocketClose },
    });
    this._clientIpBySocket.set(ws, clientIp);
    this._connectionsByIp.set(clientIp, activeForIp + 1);

    ws.on("message", onMessage);
    ws.on("close", onClose);
    ws.on("error", onError);
    ws.on?.("pong", onPong);
    rawSocket?.once?.("close", onSocketClose);

    this._send(ws, {
      type: "welcome",
      message: "Connected to SmartDrop price stream",
      max_assets_per_client: MAX_ASSETS_PER_CLIENT,
      poll_interval_ms: this._pollIntervalMs,
    });
    return true;
  }

  _onMessage(ws, raw) {
    if (typeof raw === "string" ? raw.length > MAX_MESSAGE_BYTES : raw.byteLength > MAX_MESSAGE_BYTES) {
      this._sendError(ws, "MESSAGE_TOO_LARGE", `Message exceeds ${MAX_MESSAGE_BYTES} bytes`);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      this._sendError(ws, "INVALID_JSON", "Message must be valid JSON");
      return;
    }

    if (!msg || typeof msg.type !== "string") {
      this._sendError(ws, "MISSING_TYPE", "Message must contain a string \"type\" field");
      return;
    }

    switch (msg.type) {
      case "subscribe":
        this._handleSubscribe(ws, msg);
        break;
      case "unsubscribe":
        this._handleUnsubscribe(ws, msg);
        break;
      case "pong":
        this._handlePong(ws);
        break;
      default:
        this._sendError(ws, "UNKNOWN_TYPE", `Unknown message type: ${msg.type}`);
    }
  }

  _handleSubscribe(ws, msg) {
    const client = this._clients.get(ws);
    if (!client) return;

    if (!Array.isArray(msg.assets) || msg.assets.length === 0) {
      this._sendError(ws, "INVALID_ASSETS", "\"assets\" must be a non-empty array of asset codes");
      return;
    }

    const normalized = [];
    for (const raw of msg.assets) {
      if (typeof raw !== "string") {
        this._sendError(ws, "INVALID_ASSET_CODE", "Each asset code must be a string");
        return;
      }
      const code = raw.trim().toUpperCase();
      if (!VALID_ASSET_RE.test(code)) {
        this._sendError(ws, "INVALID_ASSET_CODE", `Invalid asset code: "${raw}". Must be 1-12 uppercase alphanumeric characters`);
        return;
      }
      normalized.push(code);
    }

    const combined = new Set([...client.assets, ...normalized]);
    if (combined.size > MAX_ASSETS_PER_CLIENT) {
      this._sendError(
        ws,
        "TOO_MANY_ASSETS",
        `Cannot subscribe to more than ${MAX_ASSETS_PER_CLIENT} assets (currently ${client.assets.size}, requested +${normalized.filter((a) => !client.assets.has(a)).length})`
      );
      return;
    }

    for (const code of normalized) {
      client.assets.add(code);
      if (!this._assetSubscribers.has(code)) {
        this._assetSubscribers.set(code, new Set());
      }
      this._assetSubscribers.get(code).add(ws);
    }

    this._send(ws, {
      type: "subscribed",
      assets: Array.from(client.assets),
    });

    this._sendInitialSnapshot(ws, normalized).catch((err) => {
      logger.warn("Failed to send initial price snapshot", { error: err.message });
    });
  }

  _handleUnsubscribe(ws, msg) {
    const client = this._clients.get(ws);
    if (!client) return;

    if (!Array.isArray(msg.assets) || msg.assets.length === 0) {
      this._sendError(ws, "INVALID_ASSETS", "\"assets\" must be a non-empty array of asset codes");
      return;
    }

    for (const raw of msg.assets) {
      if (typeof raw !== "string") continue;
      const code = raw.trim().toUpperCase();
      client.assets.delete(code);
      const subs = this._assetSubscribers.get(code);
      if (subs) {
        subs.delete(ws);
        if (subs.size === 0) {
          this._assetSubscribers.delete(code);
          this._previousPrices.delete(code);
        }
      }
    }

    this._send(ws, {
      type: "unsubscribed",
      assets: Array.from(client.assets),
    });
  }

  _handlePong(ws) {
    const client = this._clients.get(ws);
    if (client) {
      client.missedPings = 0;
    }
  }

  _remove(ws) {
    const client = this._clients.get(ws);
    if (!client) return false;

    if (client.listeners) {
      const { onMessage, onClose, onError, onPong, rawSocket, onSocketClose } = client.listeners;
      ws.removeListener?.("message", onMessage);
      ws.removeListener?.("close", onClose);
      ws.removeListener?.("error", onError);
      ws.removeListener?.("pong", onPong);
      rawSocket?.removeListener?.("close", onSocketClose);
    }

    for (const code of client.assets) {
      const subs = this._assetSubscribers.get(code);
      if (subs) {
        subs.delete(ws);
        if (subs.size === 0) {
          this._assetSubscribers.delete(code);
          this._previousPrices.delete(code);
        }
      }
    }
    client.assets.clear();

    this._clients.delete(ws);
    const clientIp = this._clientIpBySocket.get(ws);
    if (clientIp) {
      this._clientIpBySocket.delete(ws);
      const nextCount = (this._connectionsByIp.get(clientIp) || 1) - 1;
      if (nextCount > 0) {
        this._connectionsByIp.set(clientIp, nextCount);
      } else {
        this._connectionsByIp.delete(clientIp);
      }
    }
    return true;
  }

  _extractClientIp(ws, req) {
    const forwardedFor = req?.headers?.["x-forwarded-for"];
    if (typeof forwardedFor === "string" && forwardedFor.trim().length > 0) {
      return forwardedFor.split(",")[0].trim();
    }

    const candidates = [
      req?.ip,
      req?.socket?.remoteAddress,
      req?.connection?.remoteAddress,
      ws?._socket?.remoteAddress,
    ];
    const found = candidates.find((ip) => typeof ip === "string" && ip.trim().length > 0);
    return found ? found.trim() : "unknown";
  }

  async _sendInitialSnapshot(ws, assetCodes) {
    for (const code of assetCodes) {
      if (!this._clients.has(ws)) return;
      try {
        const data = await this._oracle.getPrice(code);
        if (data && data.price_usd !== null && this._clients.has(ws)) {
          this._send(ws, {
            type: "price_update",
            asset_code: data.asset_code,
            price_usd: data.price_usd,
            change_24h: data.change_24h ?? null,
            source: data.source,
            timestamp: data.last_updated || new Date().toISOString(),
          });
        }
      } catch {
        // Individual asset failure on snapshot is non-fatal
      }
    }
  }

  async _pollAndBroadcast() {
    const assets = this.trackedAssets;
    if (assets.length === 0) return;

    const results = await Promise.allSettled(
      assets.map((code) => this._oracle.getPrice(code))
    );

    for (let i = 0; i < assets.length; i++) {
      const code = assets[i];
      const outcome = results[i];
      if (outcome.status !== "fulfilled" || !outcome.value) continue;

      const data = outcome.value;
      if (data.price_usd === null) continue;

      const prev = this._previousPrices.get(code);
      if (prev !== undefined && prev === data.price_usd) continue;
      this._previousPrices.set(code, data.price_usd);

      const subs = this._assetSubscribers.get(code);
      if (!subs || subs.size === 0) continue;

      const payload = {
        type: "price_update",
        asset_code: data.asset_code,
        price_usd: data.price_usd,
        change_24h: data.change_24h ?? null,
        source: data.source,
        timestamp: data.last_updated || new Date().toISOString(),
      };

      for (const ws of Array.from(subs)) {
        this._send(ws, payload);
      }
    }
  }

  _heartbeat() {
    for (const [ws, client] of Array.from(this._clients.entries())) {
      if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
        this._remove(ws);
        continue;
      }
      if (client.missedPings >= MAX_MISSED_PINGS) {
        logger.info("Terminating unresponsive WS client");
        this._remove(ws);
        ws.terminate?.();
        continue;
      }
      client.missedPings += 1;
      this._send(ws, { type: "ping", timestamp: new Date().toISOString() });
    }
  }

  _send(ws, data) {
    if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
      this._remove(ws);
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(data));
    } catch (err) {
      logger.warn("WS send failed", { error: err.message });
      this._remove(ws);
    }
  }

  _sendError(ws, code, message) {
    this._send(ws, { type: "error", code, message });
  }
}

module.exports = {
  PriceSubscriptionManager,
  MAX_ASSETS_PER_CLIENT,
  MAX_MESSAGE_BYTES,
  HEARTBEAT_INTERVAL_MS,
  MAX_MISSED_PINGS,
  DEFAULT_MAX_CONNECTIONS_PER_IP,
};