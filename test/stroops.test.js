'use strict';

const { toStroops, sumStroops, stroopsEqual, STROOPS_PER_UNIT, MAX_DECIMALS } = require('../src/utils/stroops');

describe('stroops utils', () => {
  describe('toStroops', () => {
    test('converts 1.0 to 10000000 stroops', () => {
      expect(toStroops(1.0)).toBe(10000000n);
    });

    test('converts 0.0000001 (1 stroop) correctly', () => {
      expect(toStroops(0.0000001)).toBe(1n);
    });

    test('converts 1.5 to 15000000 stroops', () => {
      expect(toStroops(1.5)).toBe(15000000n);
    });

    test('converts 0 to 0 stroops', () => {
      expect(toStroops(0)).toBe(0n);
    });

    test('handles amounts with fewer than 7 decimals', () => {
      expect(toStroops(1.1)).toBe(11000000n);
      expect(toStroops(1.12)).toBe(11200000n);
      expect(toStroops(1.123)).toBe(11230000n);
    });

    test('handles large amounts', () => {
      expect(toStroops(1000000)).toBe(10000000000000n);
    });

    test('throws on NaN', () => {
      expect(() => toStroops(NaN)).toThrow('non-negative finite number');
    });

    test('throws on Infinity', () => {
      expect(() => toStroops(Infinity)).toThrow('non-negative finite number');
    });

    test('throws on negative values', () => {
      expect(() => toStroops(-1)).toThrow('non-negative finite number');
    });

    test('throws on more than 7 decimal places', () => {
      expect(() => toStroops(1.00000001)).toThrow('at most 7 decimal places');
    });

    test('accepts exactly 7 decimal places', () => {
      expect(toStroops(1.1234567)).toBe(11234567n);
    });

    test('rejects float imprecision beyond 7 decimals (0.1+0.2 scenario)', () => {
      // 0.1 + 0.2 = 0.30000000000000004 in JS float — exceeds 7 decimals
      expect(() => toStroops(0.1 + 0.2)).toThrow('at most 7 decimal places');
    });
  });

  describe('sumStroops', () => {
    test('sums multiple recipients correctly', () => {
      const recipients = [
        { amount: 1.5 },
        { amount: 2.3 },
        { amount: 0.2 },
      ];
      expect(sumStroops(recipients)).toBe(40000000n);
    });

    test('returns 0n for empty array', () => {
      expect(sumStroops([])).toBe(0n);
    });

    test('handles precise decimal amounts without float drift', () => {
      const recipients = [
        { amount: 0.1 },
        { amount: 0.2 },
      ];
      // 0.1 → 1000000n, 0.2 → 2000000n, sum → 3000000n
      expect(sumStroops(recipients)).toBe(3000000n);
    });
  });

  describe('stroopsEqual', () => {
    test('returns true for equal amounts', () => {
      expect(stroopsEqual(1.0, 1.0)).toBe(true);
    });

    test('returns true for amounts with different trailing zeros', () => {
      expect(stroopsEqual(1.0, 1.00)).toBe(true);
    });

    test('returns false for different amounts', () => {
      expect(stroopsEqual(1.0, 1.1)).toBe(false);
    });

    test('throws for float-imprecise values exceeding 7 decimals', () => {
      expect(() => stroopsEqual(0.3, 0.1 + 0.2)).toThrow('at most 7 decimal places');
    });
  });

  test('STROOPS_PER_UNIT is 10_000_000', () => {
    expect(STROOPS_PER_UNIT).toBe(10000000n);
  });

  test('MAX_DECIMALS is 7', () => {
    expect(MAX_DECIMALS).toBe(7);
  });
});
