'use strict';

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../src/logger', () => mockLogger);

function loadCircuitBreaker() {
  jest.resetModules();
  mockLogger.error.mockClear();
  mockLogger.warn.mockClear();
  return require('../src/services/sources/circuitBreaker');
}

describe('circuit breaker', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('starts closed', () => {
    const { createCircuitBreaker } = loadCircuitBreaker();
    const circuit = createCircuitBreaker({
      sourceName: 'test-source',
      cooldownMs: 60000,
      reminderIntervalMs: 30000,
    });

    expect(circuit.isOpen()).toBe(false);
    expect(circuit.getState()).toEqual({ source: 'test-source', open: false, openUntil: null });
  });

  test('open() trips the circuit and logs distinctly at error level the first time', () => {
    const { createCircuitBreaker } = loadCircuitBreaker();
    const circuit = createCircuitBreaker({
      sourceName: 'test-source',
      cooldownMs: 60000,
      reminderIntervalMs: 30000,
    });

    circuit.open({ assetCode: 'XLM' });

    expect(circuit.isOpen()).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Price source permanently misconfigured',
      expect.objectContaining({ source: 'test-source', assetCode: 'XLM', cooldownMs: 60000 })
    );
  });

  test('open() called again while already open does not repeat the error log', () => {
    const { createCircuitBreaker } = loadCircuitBreaker();
    const circuit = createCircuitBreaker({
      sourceName: 'test-source',
      cooldownMs: 60000,
      reminderIntervalMs: 30000,
    });

    circuit.open();
    circuit.open();
    circuit.open();

    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });

  test('remains open until cooldownMs elapses', () => {
    const { createCircuitBreaker } = loadCircuitBreaker();
    const circuit = createCircuitBreaker({
      sourceName: 'test-source',
      cooldownMs: 60000,
      reminderIntervalMs: 30000,
    });

    circuit.open();
    jest.advanceTimersByTime(59999);
    expect(circuit.isOpen()).toBe(true);

    jest.advanceTimersByTime(2);
    expect(circuit.isOpen()).toBe(false);
  });

  test('close() resets the circuit immediately', () => {
    const { createCircuitBreaker } = loadCircuitBreaker();
    const circuit = createCircuitBreaker({
      sourceName: 'test-source',
      cooldownMs: 60000,
      reminderIntervalMs: 30000,
    });

    circuit.open();
    expect(circuit.isOpen()).toBe(true);

    circuit.close();
    expect(circuit.isOpen()).toBe(false);
    expect(circuit.getState()).toEqual({ source: 'test-source', open: false, openUntil: null });
  });

  test('noteSkipped logs at most once per reminderIntervalMs while open', () => {
    const { createCircuitBreaker } = loadCircuitBreaker();
    const circuit = createCircuitBreaker({
      sourceName: 'test-source',
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

  test('re-opening after a fresh failure logs the error again', () => {
    const { createCircuitBreaker } = loadCircuitBreaker();
    const circuit = createCircuitBreaker({
      sourceName: 'test-source',
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
