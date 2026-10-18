const EventEmitter = require("events");
const WebSocket = require("ws");
const { PriceSubscriptionManager } = require("../src/ws/PriceSubscriptionManager");

function createMockSocket(readyState = WebSocket.OPEN) {
  const ws = new EventEmitter();
  ws.readyState = readyState;
  ws.sent = [];
  ws.send = jest.fn((payload) => ws.sent.push(JSON.parse(payload)));
  ws.close = jest.fn(() => {
    ws.readyState = WebSocket.CLOSED;
    ws.emit("close");
  });
  ws.terminate = jest.fn(() => {
    ws.readyState = WebSocket.CLOSED;
  });
  return ws;
}

describe("WebSocket connection cleanup (#528)", () => {
  test("detaches event listeners and frees per-IP and asset subscriptions on disconnect", () => {
    const mgr = new PriceSubscriptionManager({ oracle: { getPrice: jest.fn().mockResolvedValue(null) } });
    const rawSocket = new EventEmitter();
    const ws = createMockSocket();

    expect(mgr.add(ws, { ip: "10.0.0.5", socket: rawSocket })).toBe(true);
    ws.emit("message", JSON.stringify({ type: "subscribe", assets: ["XLM", "USDC"] }));
    expect(mgr.clientCount).toBe(1);
    expect(mgr.trackedAssets).toEqual(["XLM", "USDC"]);

    rawSocket.emit("close");
    expect(mgr.clientCount).toBe(0);
    expect(mgr.trackedAssets).toEqual([]);
    expect(ws.listenerCount("message")).toBe(0);
    expect(ws.listenerCount("close")).toBe(0);
    expect(ws.listenerCount("error")).toBe(0);
  });

  test("removes dead/closed sockets automatically when send fails or socket is CLOSED", () => {
    const mgr = new PriceSubscriptionManager({ oracle: { getPrice: jest.fn().mockResolvedValue(null) } });
    const ws = createMockSocket();
    mgr.add(ws, { ip: "10.0.0.6" });
    ws.emit("message", JSON.stringify({ type: "subscribe", assets: ["XLM"] }));

    ws.send.mockImplementationOnce(() => {
      throw new Error("Broken pipe");
    });
    mgr._send(ws, { type: "ping" });

    expect(mgr.clientCount).toBe(0);
    expect(mgr.trackedAssets).toEqual([]);
  });

  test("cleans up non-open sockets during shutdown without leaking state", async () => {
    const mgr = new PriceSubscriptionManager({ oracle: { getPrice: jest.fn().mockResolvedValue(null) } });
    const ws = createMockSocket();
    mgr.add(ws, { ip: "10.0.0.7" });
    ws.readyState = WebSocket.CLOSING;

    await mgr.shutdown();
    expect(mgr.clientCount).toBe(0);
    expect(ws.terminate).toHaveBeenCalled();
  });
});