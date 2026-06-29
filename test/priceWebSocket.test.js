'use strict';

const http = require('http');
const WebSocket = require('ws');

// ── Mock dependencies so the test never needs Redis or real price sources ──

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../src/services/cache', () => ({
  isConnected: jest.fn(() => false),
  get: jest.fn(),
  set: jest.fn(),
  disconnect: jest.fn(),
  getClient: jest.fn(),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function waitForMessage(ws, matcher) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for WS message')), 3000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (!matcher || matcher(msg)) {
        clearTimeout(timer);
        resolve(msg);
      }
    });
  });
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function send(ws, payload) {
  ws.send(JSON.stringify(payload));
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('WebSocket price stream', () => {
  let httpServer;
  let subscriptionManager;
  let port;

  beforeAll((done) => {
    // Fresh module instances for each test suite run.
    jest.resetModules();

    const { PriceSubscriptionManager } = require('../src/ws/PriceSubscriptionManager');
    subscriptionManager = new PriceSubscriptionManager();

    const { WebSocketServer } = require('ws');
    httpServer = http.createServer();
    const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
    wss.on('connection', (ws, req) => subscriptionManager.add(ws));

    httpServer.listen(0, () => {
      port = httpServer.address().port;
      done();
    });
  });

  afterAll((done) => {
    subscriptionManager.stopHeartbeat();
    // Terminate any lingering client sockets so httpServer.close() resolves.
    for (const ws of subscriptionManager._clients.keys()) {
      ws.terminate();
    }
    setTimeout(() => httpServer.close(done), 100);
  }, 10000);

  test('client receives subscribed confirmation after subscribe action', async () => {
    const ws = await connect(port);
    const msgPromise = waitForMessage(ws, (m) => m.type === 'subscribed');
    send(ws, { action: 'subscribe', assets: ['XLM', 'USDC'] });
    const msg = await msgPromise;
    expect(msg.assets).toEqual(expect.arrayContaining(['XLM', 'USDC']));
    ws.close();
  });

  test('subscribe caps assets at MAX_ASSETS_PER_CLIENT (5)', async () => {
    const ws = await connect(port);
    const msgPromise = waitForMessage(ws, (m) => m.type === 'subscribed');
    send(ws, { action: 'subscribe', assets: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] });
    const msg = await msgPromise;
    expect(msg.assets.length).toBeLessThanOrEqual(5);
    ws.close();
  });

  test('client receives price_update after price changes > 0.1%', async () => {
    const ws = await connect(port);

    // Subscribe first
    const subPromise = waitForMessage(ws, (m) => m.type === 'subscribed');
    send(ws, { action: 'subscribe', assets: ['XLM'] });
    await subPromise;

    // Seed a previous price, then push a >0.1% change
    subscriptionManager._previousPrices.set('XLM', 0.112);

    const updatePromise = waitForMessage(ws, (m) => m.type === 'price_update');
    subscriptionManager.notifyPriceUpdates({ XLM: { price: 0.1145, source: 'stellar_dex' } });

    const update = await updatePromise;
    expect(update.asset).toBe('XLM');
    expect(update.price_usd).toBe(0.1145);
    expect(update.previous_price_usd).toBe(0.112);
    expect(Math.abs(update.change_pct)).toBeGreaterThan(0.1);
    ws.close();
  });

  test('no push when price change is within 0.1% threshold', async () => {
    const ws = await connect(port);

    const subPromise = waitForMessage(ws, (m) => m.type === 'subscribed');
    send(ws, { action: 'subscribe', assets: ['USDC'] });
    await subPromise;

    subscriptionManager._previousPrices.set('USDC', 1.0000);

    let received = false;
    ws.on('message', () => { received = true; });

    // Change < 0.1%
    subscriptionManager.notifyPriceUpdates({ USDC: { price: 1.00005, source: 'coingecko' } });

    // Wait briefly to confirm nothing was sent
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toBe(false);
    ws.close();
  });

  test('unsubscribe removes asset from client subscription', async () => {
    const ws = await connect(port);

    const subPromise = waitForMessage(ws, (m) => m.type === 'subscribed');
    send(ws, { action: 'subscribe', assets: ['XLM'] });
    await subPromise;

    const unsubPromise = waitForMessage(ws, (m) => m.type === 'unsubscribed');
    send(ws, { action: 'unsubscribe', assets: ['XLM'] });
    const msg = await unsubPromise;
    expect(msg.assets).not.toContain('XLM');
    ws.close();
  });

  test('invalid JSON returns error message', async () => {
    const ws = await connect(port);
    const errPromise = waitForMessage(ws, (m) => m.type === 'error');
    ws.send('not-json');
    const msg = await errPromise;
    expect(msg.message).toMatch(/invalid json/i);
    ws.close();
  });

  test('connectionCount increments on connect and decrements on disconnect', async () => {
    // Wait for any sockets from earlier tests to fully close.
    await new Promise((r) => setTimeout(r, 200));
    const before = subscriptionManager.connectionCount;
    const ws = await connect(port);
    await new Promise((r) => setTimeout(r, 100));
    expect(subscriptionManager.connectionCount).toBe(before + 1);
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(subscriptionManager.connectionCount).toBe(before);
  });
});
