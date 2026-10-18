"use strict";

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

async function expectFailure(breaker) {
  await expect(
    breaker.call(async () => {
      throw new Error("source unavailable");
    }),
  ).rejects.toThrow("source unavailable");
}

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

    await expectFailure(breaker);
    await expectFailure(breaker);

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

  // Issue #374: _transitionTo reset failureCount to 0 *before* logging the
  // transition, so the CLOSED -> OPEN log line could never report how many
  // failures actually tripped the breaker.
  test("logs the failure count that tripped the breaker, not the post-reset zero", async () => {
    const { breaker, logger } = buildBreaker({ failureThreshold: 2 });

    await expectFailure(breaker); // failureCount: 1, still closed
    await expectFailure(breaker); // failureCount: 2 -> trips open

    expect(logger.info).toHaveBeenCalledWith(
      "Circuit breaker state changed",
      expect.objectContaining({
        from: STATES.CLOSED,
        to: STATES.OPEN,
        failure_count: 2,
        success_count: 0,
      }),
    );
    // The reset itself must still happen -- only the log line was wrong.
    expect(breaker.failureCount).toBe(0);
  });

  test("moves to half-open after cooldown and closes on a successful probe", async () => {
    const { breaker, advance } = buildBreaker();

    await expectFailure(breaker);
    await expectFailure(breaker);

    advance(100);
    expect(breaker.getState()).toBe(STATES.HALF_OPEN);

    await expect(breaker.call(async () => 0.12)).resolves.toBe(0.12);

    expect(breaker.getState()).toBe(STATES.CLOSED);
  });

  test("reopens when the half-open probe fails", async () => {
    const { breaker, advance } = buildBreaker();

    await expectFailure(breaker);
    await expectFailure(breaker);

    advance(100);
    await expectFailure(breaker);

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

  test("treats null and undefined returns as successes", async () => {
    const { breaker } = buildBreaker();

    await expect(breaker.call(async () => null)).resolves.toBeNull();
    await expect(breaker.call(async () => undefined)).resolves.toBeNull();
    expect(breaker.failureCount).toBe(0);
    expect(breaker.getState()).toBe(STATES.CLOSED);
  });

  test("resets failure count on success in CLOSED state", async () => {
    const { breaker } = buildBreaker();

    await expectFailure(breaker);
    expect(breaker.failureCount).toBe(1);

    await breaker.call(async () => "ok");
    expect(breaker.failureCount).toBe(0);
  });

  test("reset() returns breaker to CLOSED immediately", async () => {
    const { breaker } = buildBreaker();

    await expectFailure(breaker);
    await expectFailure(breaker);
    expect(breaker.getState()).toBe(STATES.OPEN);

    breaker.reset();
    expect(breaker.getState()).toBe(STATES.CLOSED);
    expect(breaker.failureCount).toBe(0);
    expect(breaker.openedAt).toBeNull();
  });

  test("skips calls when half-open probe is already in flight", async () => {
    const { breaker, advance } = buildBreaker();

    await expectFailure(breaker);
    await expectFailure(breaker);
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
    await expectFailure(breaker);
    await expectFailure(breaker);
    expect(breaker.isOpen()).toBe(true);
  });

  test("multiple successes in half-open are needed when successThreshold > 1", async () => {
    const { breaker, advance } = buildBreaker({ successThreshold: 2 });

    await expectFailure(breaker);
    await expectFailure(breaker);
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
      await expectFailure(breaker);
    }
    expect(breaker.getState()).toBe(STATES.CLOSED);

    await expectFailure(breaker);
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

describe("Circuit Breaker for External Service Calls (#498)", () => {
  const { CircuitBreakerOpenError, isDependencyFailure } = require("../src/utils/circuitBreaker");

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("opens after reaching the failure threshold within rolling window", async () => {
    const breaker = new CircuitBreaker("external-api", {
      failureThreshold: 3,
      windowMs: 60000,
      cooldownMs: 30000,
      throwOnOpen: true,
    });

    const networkError = new Error("ECONNRESET");
    networkError.code = "ECONNRESET";

    // 2 failures: still closed
    for (let i = 0; i < 2; i++) {
      await expect(breaker.execute(async () => { throw networkError; })).rejects.toThrow("ECONNRESET");
      expect(breaker.isOpen()).toBe(false);
      expect(breaker.getState()).toBe("closed");
    }

    // 3rd failure trips the breaker OPEN
    await expect(breaker.execute(async () => { throw networkError; })).rejects.toThrow("ECONNRESET");
    expect(breaker.isOpen()).toBe(true);
    expect(breaker.getState()).toBe("open");
  });

  test("fails fast with typed CircuitBreakerOpenError mapping to 503 and Retry-After header while OPEN", async () => {
    const breaker = new CircuitBreaker("payment-gw", {
      failureThreshold: 2,
      cooldownMs: 30000,
      throwOnOpen: true,
    });

    const serverError = new Error("Bad Gateway");
    serverError.status = 502;

    await expect(breaker.execute(async () => { throw serverError; })).rejects.toThrow("Bad Gateway");
    await expect(breaker.execute(async () => { throw serverError; })).rejects.toThrow("Bad Gateway");

    expect(breaker.isOpen()).toBe(true);

    // Call while OPEN must fail fast without executing the fn
    const actionMock = jest.fn();
    try {
      await breaker.execute(actionMock);
      throw new Error("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitBreakerOpenError);
      expect(err.statusCode).toBe(503);
      expect(err.code).toBe("SERVICE_UNAVAILABLE");
      expect(err.retryAfter).toBeGreaterThan(0);
      expect(err.retryAfter).toBeLessThanOrEqual(30);
      expect(err.message).toContain("payment-gw");
      expect(actionMock).not.toHaveBeenCalled();
    }
  });

  test("moves to half-open after cooldownMs elapses", async () => {
    const breaker = new CircuitBreaker("stellar-horizon", {
      failureThreshold: 1,
      cooldownMs: 15000,
      throwOnOpen: true,
    });

    const err = new Error("Timeout");
    err.code = "ETIMEDOUT";

    await expect(breaker.execute(async () => { throw err; })).rejects.toThrow("Timeout");
    expect(breaker.getState()).toBe("open");

    // Advance 14.99 seconds: still open
    jest.advanceTimersByTime(14999);
    expect(breaker.getState()).toBe("open");

    // Advance past cooldown: transitions to half-open
    jest.advanceTimersByTime(2);
    expect(breaker.getState()).toBe("half-open");
  });

  test("closes after a successful trial call in half-open", async () => {
    const breaker = new CircuitBreaker("rates-api", {
      failureThreshold: 1,
      cooldownMs: 10000,
      trialCount: 1,
      successThreshold: 1,
      throwOnOpen: true,
    });

    const err = new Error("Gateway timeout");
    err.status = 504;

    await expect(breaker.execute(async () => { throw err; })).rejects.toThrow("Gateway timeout");
    expect(breaker.getState()).toBe("open");

    jest.advanceTimersByTime(10001);
    expect(breaker.getState()).toBe("half-open");

    // Trial call succeeds
    const result = await breaker.execute(async () => ({ rate: 1.25 }));
    expect(result).toEqual({ rate: 1.25 });

    // Should now be closed
    expect(breaker.getState()).toBe("closed");
    expect(breaker.isOpen()).toBe(false);
  });

  test("reopens when a trial call in half-open fails", async () => {
    const breaker = new CircuitBreaker("remote-service", {
      failureThreshold: 1,
      cooldownMs: 20000,
      throwOnOpen: true,
    });

    const err500 = new Error("Internal Server Error");
    err500.status = 500;

    await expect(breaker.execute(async () => { throw err500; })).rejects.toThrow("Internal Server Error");
    expect(breaker.getState()).toBe("open");

    jest.advanceTimersByTime(20001);
    expect(breaker.getState()).toBe("half-open");

    // Trial call fails with dependency error
    await expect(breaker.execute(async () => { throw err500; })).rejects.toThrow("Internal Server Error");

    // Circuit reopens immediately
    expect(breaker.getState()).toBe("open");
    expect(breaker.isOpen()).toBe(true);
  });

  test("ignores 4xx client errors (400, 401, 404, 422) and only counts 5xx, 429, and network failures", async () => {
    const breaker = new CircuitBreaker("auth-guarded-api", {
      failureThreshold: 2,
      throwOnOpen: true,
    });

    // 400 Bad Request
    const badRequest = new Error("Bad Request");
    badRequest.status = 400;

    // 401 Unauthorized
    const unauth = new Error("Unauthorized");
    unauth.status = 401;

    // 404 Not Found
    const notFound = new Error("Not Found");
    notFound.status = 404;

    // 422 Unprocessable
    const unproc = new Error("Unprocessable");
    unproc.status = 422;

    for (const clientErr of [badRequest, unauth, notFound, unproc]) {
      await expect(breaker.execute(async () => { throw clientErr; })).rejects.toThrow(clientErr.message);
      expect(breaker.isOpen()).toBe(false);
      expect(breaker.getFailureCount()).toBe(0);
    }

    // Now send 429 (Too Many Requests - genuine dependency failure)
    const rateLimited = new Error("Too Many Requests");
    rateLimited.status = 429;
    await expect(breaker.execute(async () => { throw rateLimited; })).rejects.toThrow("Too Many Requests");
    expect(breaker.getFailureCount()).toBe(1);

    // And send 503 (Service Unavailable - genuine dependency failure)
    const unavailable = new Error("Service Unavailable");
    unavailable.status = 503;
    await expect(breaker.execute(async () => { throw unavailable; })).rejects.toThrow("Service Unavailable");

    // Reached failureThreshold (2) of genuine failures -> OPEN!
    expect(breaker.isOpen()).toBe(true);
  });

  test("rolling window expires old failures so transient blips do not trip breaker", async () => {
    const breaker = new CircuitBreaker("windowed-client", {
      failureThreshold: 3,
      windowMs: 10000, // 10s window
      throwOnOpen: true,
    });

    const netErr = new Error("ECONNREFUSED");
    netErr.code = "ECONNREFUSED";

    // 2 failures at t=0
    await expect(breaker.execute(async () => { throw netErr; })).rejects.toThrow();
    await expect(breaker.execute(async () => { throw netErr; })).rejects.toThrow();
    expect(breaker.getFailureCount()).toBe(2);

    // Advance 11 seconds (past the 10s window)
    jest.advanceTimersByTime(11000);

    // Old failures expired from the window
    expect(breaker.getFailureCount()).toBe(0);

    // 1 failure at t=11s
    await expect(breaker.execute(async () => { throw netErr; })).rejects.toThrow();
    expect(breaker.getFailureCount()).toBe(1);
    expect(breaker.isOpen()).toBe(false);
  });
});

