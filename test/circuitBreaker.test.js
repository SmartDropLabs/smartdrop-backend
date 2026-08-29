"use strict";

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock("../src/logger", () => mockLogger);

const { CircuitBreaker, STATES } = require("../src/utils/circuitBreaker");

function buildBreaker(options = {}) {
  let now = 1000;
  const logger = {
    info: jest.fn(),
  };

  const breaker = new CircuitBreaker("coingecko", {
    failureThreshold: 2,
    successThreshold: 1,
    timeoutMs: 100,
    now: () => now,
    logger,
    ...options,
  });

  return {
    breaker,
    logger,
    advance(ms) {
      now += ms;
    },
  };
}

describe("CircuitBreaker", () => {
  test("opens after repeated failures and skips calls while cooling down", async () => {
    const { breaker, logger } = buildBreaker();

    await expect(breaker.call(async () => null)).resolves.toBeNull();
    await expect(breaker.call(async () => null)).resolves.toBeNull();

    expect(breaker.getState()).toBe(STATES.OPEN);

    const sourceFetch = jest.fn(async () => 0.12);
    await expect(breaker.call(sourceFetch)).resolves.toBeNull();

    expect(sourceFetch).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "Circuit breaker state changed",
      expect.objectContaining({
        source: "coingecko",
        from: STATES.CLOSED,
        to: STATES.OPEN,
        reason: "failure-threshold",
      }),
    );
  });

  test("moves to half-open after cooldown and closes on a successful probe", async () => {
    const { breaker, advance } = buildBreaker();

    await breaker.call(async () => null);
    await breaker.call(async () => null);

    advance(100);
    expect(breaker.getState()).toBe(STATES.HALF_OPEN);

    await expect(breaker.call(async () => 0.12)).resolves.toBe(0.12);

    expect(breaker.getState()).toBe(STATES.CLOSED);
  });

  test("reopens when the half-open probe fails", async () => {
    const { breaker, advance } = buildBreaker();

    await breaker.call(async () => null);
    await breaker.call(async () => null);

    advance(100);
    await expect(breaker.call(async () => null)).resolves.toBeNull();

    expect(breaker.getState()).toBe(STATES.OPEN);
  });

  test("records thrown source errors as failures and rethrows them", async () => {
    const { breaker } = buildBreaker();
    const error = new Error("rate limited");

    await expect(
      breaker.call(async () => {
        throw error;
      }),
    ).rejects.toThrow("rate limited");

    expect(breaker.getState()).toBe(STATES.CLOSED);
  });

  test("treats undefined return as a failure", async () => {
    const { breaker } = buildBreaker();

    await breaker.call(async () => undefined);
    expect(breaker.failureCount).toBe(1);
  });

  test("resets failure count on success in CLOSED state", async () => {
    const { breaker } = buildBreaker();

    await breaker.call(async () => null);
    expect(breaker.failureCount).toBe(1);

    await breaker.call(async () => "ok");
    expect(breaker.failureCount).toBe(0);
  });

  test("reset() returns breaker to CLOSED immediately", async () => {
    const { breaker } = buildBreaker();

    await breaker.call(async () => null);
    await breaker.call(async () => null);
    expect(breaker.getState()).toBe(STATES.OPEN);

    breaker.reset();
    expect(breaker.getState()).toBe(STATES.CLOSED);
    expect(breaker.failureCount).toBe(0);
    expect(breaker.openedAt).toBeNull();
  });

  test("skips calls when half-open probe is already in flight", async () => {
    const { breaker, advance } = buildBreaker();

    await breaker.call(async () => null);
    await breaker.call(async () => null);
    advance(100);

    expect(breaker.getState()).toBe(STATES.HALF_OPEN);

    // First call starts a probe
    const probe = breaker.call(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return "ok";
    });

    // Second call while probe is in flight should be skipped
    const skipped = await breaker.call(async () => "should-not-run");
    expect(skipped).toBeNull();

    await probe;
    expect(breaker.getState()).toBe(STATES.CLOSED);
  });

  test("clamps failureThreshold to minimum of 1", () => {
    const breaker = new CircuitBreaker("test", { failureThreshold: 0 });
    expect(breaker.failureThreshold).toBe(1);
  });

  test("clamps successThreshold to minimum of 1", () => {
    const breaker = new CircuitBreaker("test", { successThreshold: -5 });
    expect(breaker.successThreshold).toBe(1);
  });

  test("clamps timeoutMs to minimum of 1", () => {
    const breaker = new CircuitBreaker("test", { timeoutMs: -100 });
    expect(breaker.timeoutMs).toBe(1);
  });

  test("uses default options when none provided", () => {
    const breaker = new CircuitBreaker("test");
    expect(breaker.failureThreshold).toBe(3);
    expect(breaker.successThreshold).toBe(1);
    expect(breaker.timeoutMs).toBe(30000);
  });

  test("isOpen returns false when closed", () => {
    const { breaker } = buildBreaker();
    expect(breaker.isOpen()).toBe(false);
  });

  test("isOpen returns true when open", async () => {
    const { breaker } = buildBreaker();
    await breaker.call(async () => null);
    await breaker.call(async () => null);
    expect(breaker.isOpen()).toBe(true);
  });

  test("multiple successes in half-open are needed when successThreshold > 1", async () => {
    const { breaker, advance } = buildBreaker({ successThreshold: 2 });

    await breaker.call(async () => null);
    await breaker.call(async () => null);
    advance(100);

    expect(breaker.getState()).toBe(STATES.HALF_OPEN);

    await breaker.call(async () => "ok");
    expect(breaker.getState()).toBe(STATES.HALF_OPEN);

    await breaker.call(async () => "ok");
    expect(breaker.getState()).toBe(STATES.CLOSED);
  });

  test("higher failureThreshold delays opening", async () => {
    const { breaker } = buildBreaker({ failureThreshold: 5 });

    for (let i = 0; i < 4; i++) {
      await breaker.call(async () => null);
    }
    expect(breaker.getState()).toBe(STATES.CLOSED);

    await breaker.call(async () => null);
    expect(breaker.getState()).toBe(STATES.OPEN);
  });
});

function loadCircuitBreaker() {
  jest.resetModules();
  mockLogger.error.mockClear();
  mockLogger.warn.mockClear();
  return require("../src/services/sources/circuitBreaker");
}

describe("circuit breaker", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("starts closed", () => {
    const { createCircuitBreaker } = loadCircuitBreaker();
    const circuit = createCircuitBreaker({
      sourceName: "test-source",
      cooldownMs: 60000,
      reminderIntervalMs: 30000,
    });

    expect(circuit.isOpen()).toBe(false);
    expect(circuit.getState()).toEqual({
      source: "test-source",
      open: false,
      openUntil: null,
      last_success_at: null,
    });
  });

  test("open() trips the circuit and logs distinctly at error level the first time", () => {
    const { createCircuitBreaker } = loadCircuitBreaker();
    const circuit = createCircuitBreaker({
      sourceName: "test-source",
      cooldownMs: 60000,
      reminderIntervalMs: 30000,
    });

    circuit.open({ assetCode: "XLM" });

    expect(circuit.isOpen()).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      "Price source permanently misconfigured",
      expect.objectContaining({
        source: "test-source",
        assetCode: "XLM",
        cooldownMs: 60000,
      }),
    );
  });

  test("open() called again while already open does not repeat the error log", () => {
    const { createCircuitBreaker } = loadCircuitBreaker();
    const circuit = createCircuitBreaker({
      sourceName: "test-source",
      cooldownMs: 60000,
      reminderIntervalMs: 30000,
    });

    circuit.open();
    circuit.open();
    circuit.open();

    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });

  test("remains open until cooldownMs elapses", () => {
    const { createCircuitBreaker } = loadCircuitBreaker();
    const circuit = createCircuitBreaker({
      sourceName: "test-source",
      cooldownMs: 60000,
      reminderIntervalMs: 30000,
    });

    circuit.open();
    jest.advanceTimersByTime(59999);
    expect(circuit.isOpen()).toBe(true);

    jest.advanceTimersByTime(2);
    expect(circuit.isOpen()).toBe(false);
  });

  test("close() resets the circuit immediately", () => {
    const { createCircuitBreaker } = loadCircuitBreaker();
    const circuit = createCircuitBreaker({
      sourceName: "test-source",
      cooldownMs: 60000,
      reminderIntervalMs: 30000,
    });

    circuit.open();
    expect(circuit.isOpen()).toBe(true);

    circuit.close();
    expect(circuit.isOpen()).toBe(false);
    expect(circuit.getState()).toEqual({
      source: "test-source",
      open: false,
      openUntil: null,
      last_success_at: expect.any(String),
    });
  });

  test("noteSkipped logs at most once per reminderIntervalMs while open", () => {
    const { createCircuitBreaker } = loadCircuitBreaker();
    const circuit = createCircuitBreaker({
      sourceName: "test-source",
      cooldownMs: 60000,
      reminderIntervalMs: 30000,
    });

    circuit.open();
    mockLogger.warn.mockClear();

    // open() already logged the initial failure at error level and stamped
    // the reminder clock, so immediate skips shouldn't double-log a warn.
    circuit.noteSkipped();
    circuit.noteSkipped();
    circuit.noteSkipped();
    expect(mockLogger.warn).not.toHaveBeenCalled();

    jest.advanceTimersByTime(30000);
    circuit.noteSkipped();
    circuit.noteSkipped();
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });

  test("re-opening after a fresh failure logs the error again", () => {
    const { createCircuitBreaker } = loadCircuitBreaker();
    const circuit = createCircuitBreaker({
      sourceName: "test-source",
      cooldownMs: 60000,
      reminderIntervalMs: 30000,
    });

    circuit.open();
    jest.advanceTimersByTime(60001);
    expect(circuit.isOpen()).toBe(false);

    circuit.open();
    expect(mockLogger.error).toHaveBeenCalledTimes(2);
  });
});
