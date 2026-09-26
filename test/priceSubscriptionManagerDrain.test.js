'use strict';

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../src/logger', () => mockLogger);
jest.mock('../src/config', () => ({
  ws: { maxConnections: 100, maxConnectionsPerIp: 5 },
}));

const { PriceSubscriptionManager } = require('../src/ws/PriceSubscriptionManager');

const OPEN = 1;
const CLOSED = 3;

/** Minimal fake matching the subset of the `ws` socket API this class uses. */
class FakeSocket {
  constructor() {
    this.readyState = OPEN;
    this._handlers = {};
    this.sent = [];
    this.closed = false;
    this.terminated = false;
  }

  on(event, handler) {
    (this._handlers[event] ??= []).push(handler);
  }

  emit(event, ...args) {
    for (const h of this._handlers[event] || []) h(...args);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closed = true;
    this.readyState = CLOSED;
    this.emit('close');
  }

  terminate() {
    this.terminated = true;
    this.readyState = CLOSED;
  }
}
function req(ip) {
  return { socket: { remoteAddress: ip }, headers: {} };
}

describe('PriceSubscriptionManager.drain (#364)', () => {
  let manager;

  beforeEach(() => {
    manager = new PriceSubscriptionManager();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('add() is rejected with 1013 once draining has started', () => {
    manager.drain(5000);

    const ws = new FakeSocket();
    const closeSpy = jest.spyOn(ws, 'close');
    const accepted = manager.add(ws, req('10.0.0.9'));

    expect(accepted).toBe(false);
    expect(closeSpy).toHaveBeenCalledWith(1013, 'Server shutting down');
    expect(manager.connectionCount).toBe(0);
  });

  test('sends to an open socket without relying on constructor.OPEN', () => {
    const ws = new FakeSocket();

    manager.add(ws, req('10.0.0.9'));
    manager._send(ws, { type: 'test' });

    expect(ws.sent).toEqual([{ type: 'test' }]);
  });

  test('warns every pre-drain client, then closes them after the grace delay', () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    manager.add(a, req('10.0.0.1'));
    manager.add(b, req('10.0.0.2'));

    manager.drain(4000);

    expect(a.sent[0]).toMatchObject({ type: 'server_shutdown' });
    expect(b.sent[0]).toMatchObject({ type: 'server_shutdown' });
    expect(a.closed).toBe(false);

    jest.advanceTimersByTime(1000); // closeDelayMs = min(1000, 4000/2) = 1000
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(true);
  });

  test('force-terminates anything still open once drainTimeoutMs elapses', async () => {
    const a = new FakeSocket();
    manager.add(a, req('10.0.0.1'));
    // Never actually closes on its own even after close() is called below —
    // simulate a stuck client by no-oping close().
    a.close = () => {};

    const donePromise = manager.drain(2000);
    jest.advanceTimersByTime(1000); // grace delay -> ws.close() (no-op here)
    jest.advanceTimersByTime(1000); // deadline -> ws.terminate()
    await donePromise;

    expect(a.terminated).toBe(true);
    expect(manager.drainStats.forceClosed).toBe(1);
  });

  // The core of #364: even though add() already rejects connections once
  // _draining is true (verified above), drain() now also operates on a
  // snapshot of the client set taken atomically the instant draining
  // starts, rather than the live, mutable this._clients map. This proves
  // that guarantee directly: an entry inserted into the live map by some
  // other path *after* drain() has already captured its snapshot (bypassing
  // add()'s own guard, standing in for any future bug that might do so) is
  // never touched by any later drain phase.
  test('a client inserted into the live map after drain() starts is never touched by later phases', async () => {
    const a = new FakeSocket();
    manager.add(a, req('10.0.0.1'));

    const donePromise = manager.drain(2000);

    const intruder = new FakeSocket();
    manager._clients.set(intruder, { assets: new Set(), missedPings: 0 });

    jest.advanceTimersByTime(1000);
    expect(a.closed).toBe(true);
    expect(intruder.closed).toBe(false);

    jest.advanceTimersByTime(1000);
    await donePromise;

    expect(intruder.terminated).toBe(false);
    expect(manager.drainStats.warned).toBe(1); // only `a`, captured at drain() start
  });

  test('a client that disconnects naturally between drain phases is not double-counted', async () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    manager.add(a, req('10.0.0.1'));
    manager.add(b, req('10.0.0.2'));

    const donePromise = manager.drain(2000);

    jest.advanceTimersByTime(1000); // both get ws.close() -> FakeSocket emits 'close' -> _remove()
    expect(manager.connectionCount).toBe(0);

    jest.advanceTimersByTime(1000); // deadline: nothing left to force-close
    await donePromise;

    expect(manager.drainStats.forceClosed).toBe(0);
  });

  test('drain() with no connected clients resolves immediately without scheduling timers', async () => {
    await expect(manager.drain(2000)).resolves.toBeUndefined();
    expect(manager.isDraining).toBe(true);
  });
});
