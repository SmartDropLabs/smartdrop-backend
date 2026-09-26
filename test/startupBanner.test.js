"use strict";

/**
 * Startup banner with version and config summary (issue #236).
 */

const { createCacheMock } = require("./helpers/cacheMock");

const mockHelper = createCacheMock();
jest.mock("../src/services/cache", () => mockHelper.cacheMock);

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
jest.mock("../src/logger", () => mockLogger);

const mockWarmCache = jest.fn();
jest.mock("../src/startup/cacheWarm", () => ({
  warmCache: (...args) => mockWarmCache(...args),
}));

const {
  app,
  logStartupBanner,
  sanitizeUrl,
  startServer,
} = require("../src/index");
const webhookDispatcher = require("../src/services/webhookDispatcher");
const config = require("../src/config");
const { version: appVersion } = require("../package.json");

beforeEach(() => {
  Object.values(mockLogger).forEach((fn) => fn.mockClear());
  mockWarmCache.mockReset().mockResolvedValue({});
});

describe("sanitizeUrl", () => {
  test("redacts the password from a connection URL", () => {
    expect(
      sanitizeUrl("redis://admin:hunter2@redis.internal:6379"),
    ).not.toContain("hunter2");
  });

  test("redacts the username as well", () => {
    expect(
      sanitizeUrl("postgres://smartdrop:secret@db:5432/smartdrop"),
    ).not.toContain("smartdrop:secret");
  });

  test("keeps host, port, and path so the target is still identifiable", () => {
    const sanitized = sanitizeUrl(
      "postgres://user:pw@db.internal:5432/smartdrop",
    );

    expect(sanitized).toContain("db.internal");
    expect(sanitized).toContain("5432");
    expect(sanitized).toContain("smartdrop");
  });

  test("passes credential-free URLs through unchanged in substance", () => {
    expect(sanitizeUrl("redis://localhost:6379")).toContain("localhost:6379");
  });

  test("returns null when no URL is configured", () => {
    expect(sanitizeUrl(undefined)).toBeNull();
    expect(sanitizeUrl("")).toBeNull();
  });

  test("never returns an unparseable value verbatim", () => {
    expect(sanitizeUrl("not a url at all")).toBe("[unparseable]");
  });
});

describe("startup banner", () => {
  test("logs app version, Node version, sanitized Redis URL, and watched asset count", () => {
    logStartupBanner();

    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    const [message, meta] = mockLogger.info.mock.calls[0];

    expect(message).toContain(String(config.port));
    expect(meta).toEqual(
      expect.objectContaining({
        app_version: appVersion,
        node_version: process.version,
        node_env: config.nodeEnv,
        port: config.port,
        watched_assets_count: config.watchedAssets.length,
      }),
    );
    expect(meta.redis_url).toContain("redis");
  });

  test("never logs Redis or database credentials", () => {
    process.env.DATABASE_URL = "postgres://dbuser:dbpassword@db:5432/smartdrop";

    logStartupBanner();

    const [, meta] = mockLogger.info.mock.calls[0];
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain("dbpassword");
    expect(serialized).not.toContain("dbuser");
  });

  test("starts the server when cache warming fails", async () => {
    const mockServer = { close: jest.fn() };
    const listen = jest.spyOn(app, "listen").mockReturnValue(mockServer);
    mockWarmCache.mockRejectedValueOnce(new Error("Horizon unreachable"));

    await expect(startServer()).resolves.toBe(mockServer);

    expect(listen).toHaveBeenCalledWith(config.port, expect.any(Function));
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Cache warm failed; starting server anyway",
      { error: "Horizon unreachable" },
    );
    listen.mockRestore();
  });

  test("reloads persisted webhook metrics before accepting traffic (#343)", async () => {
    const mockServer = { close: jest.fn() };
    const listen = jest.spyOn(app, "listen").mockReturnValue(mockServer);
    const hydrate = jest
      .spyOn(webhookDispatcher, "hydrateMetrics")
      .mockResolvedValue(7);

    await expect(startServer()).resolves.toBe(mockServer);

    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith(config.port, expect.any(Function));
    // Counters must be restored before a delivery can be counted into them,
    // otherwise the reload would overwrite an already-recorded delivery.
    expect(hydrate.mock.invocationCallOrder[0]).toBeLessThan(
      listen.mock.invocationCallOrder[0],
    );
    hydrate.mockRestore();
    listen.mockRestore();
  });

  test("still starts the server when webhook metrics cannot be loaded (#342)", async () => {
    const mockServer = { close: jest.fn() };
    const listen = jest.spyOn(app, "listen").mockReturnValue(mockServer);
    const hydrate = jest
      .spyOn(webhookDispatcher, "hydrateMetrics")
      .mockRejectedValueOnce(new Error("connection refused"));

    await expect(startServer()).resolves.toBe(mockServer);

    expect(listen).toHaveBeenCalledWith(config.port, expect.any(Function));
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Could not load persisted webhook delivery metrics; starting with empty counters",
      { error: "connection refused" },
    );
    hydrate.mockRestore();
    listen.mockRestore();
  });

  test("announces a degraded boot when Redis is down at startup (#342)", async () => {
    const mockServer = { close: jest.fn() };
    const listen = jest.spyOn(app, "listen").mockReturnValue(mockServer);
    const isConnected = jest
      .spyOn(require("../src/services/cache"), "isConnected")
      .mockReturnValue(false);

    await expect(startServer()).resolves.toBe(mockServer);

    expect(listen).toHaveBeenCalledWith(config.port, expect.any(Function));
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("starting in degraded mode"),
      expect.objectContaining({ redis_connected: false }),
    );
    isConnected.mockRestore();
    listen.mockRestore();
  });
});
