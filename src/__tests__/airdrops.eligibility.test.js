'use strict';

jest.mock('../services/cache', () => ({
  getClient: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
  mget: jest.fn(),
}));

jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: {
    Server: jest.fn(() => ({})),
  },
}));

jest.mock('../config', () => ({
  airdrops: { ledgerCacheTtlMs: 5000, expiryScanBatchSize: 100 },
  stellar: { horizonUrl: 'https://horizon-testnet.stellar.org' },
}));

jest.mock('../middleware/requestId', () => ({
  addRequestIdHeaderInterceptor: jest.fn((client) => client),
}));

const DAY_MS = 86400000;
const NOW = Date.parse('2026-06-01T00:00:00.000Z');

const config = require('../config');
const airdrops = require('../services/airdrops');

// A participant that satisfies every default rule.
function eligibleParticipant(overrides = {}) {
  return {
    balance: 500,
    transactionCount: 10,
    accountCreatedAt: NOW - 90 * DAY_MS,
    ...overrides,
  };
}

describe('airdrop eligibility rules (#690)', () => {
  beforeEach(() => {
    config.airdrops.eligibilityRules = undefined;
  });

  afterEach(() => {
    config.airdrops.eligibilityRules = undefined;
  });

  describe('defaults', () => {
    test('default rules match the suggested values', () => {
      expect(airdrops.DEFAULT_ELIGIBILITY_RULES).toEqual({
        minBalance: 100,
        minTransactions: 5,
        accountAge: 30 * DAY_MS,
      });
    });

    test('getEligibilityRules returns defaults when config has no overrides', () => {
      expect(airdrops.getEligibilityRules()).toEqual(airdrops.DEFAULT_ELIGIBILITY_RULES);
    });

    test('defaults are frozen', () => {
      expect(Object.isFrozen(airdrops.DEFAULT_ELIGIBILITY_RULES)).toBe(true);
    });
  });

  describe('config overrides', () => {
    test('overrides only the rules that are set, keeping other defaults', () => {
      config.airdrops.eligibilityRules = { minBalance: 250 };
      expect(airdrops.getEligibilityRules()).toEqual({
        minBalance: 250,
        minTransactions: 5,
        accountAge: 30 * DAY_MS,
      });
    });

    test('null disables a rule', () => {
      config.airdrops.eligibilityRules = { accountAge: null };
      const rules = airdrops.getEligibilityRules();
      expect(rules.accountAge).toBeNull();

      const result = airdrops.checkEligibility(
        eligibleParticipant({ accountCreatedAt: NOW }),
        { now: NOW },
      );
      expect(result.eligible).toBe(true);
    });

    test('rejects a negative or non-numeric configured rule', () => {
      config.airdrops.eligibilityRules = { minBalance: -1 };
      expect(() => airdrops.getEligibilityRules()).toThrow(/minBalance/);

      config.airdrops.eligibilityRules = { minTransactions: '5' };
      expect(() => airdrops.getEligibilityRules()).toThrow(/minTransactions/);
    });
  });

  describe('checkEligibility', () => {
    test('eligible participant passes with no reason', () => {
      const result = airdrops.checkEligibility(eligibleParticipant(), { now: NOW });
      expect(result).toEqual({ eligible: true, reason: null, reasons: [] });
    });

    test('balance exactly at minBalance is eligible', () => {
      const result = airdrops.checkEligibility(eligibleParticipant({ balance: 100 }), { now: NOW });
      expect(result.eligible).toBe(true);
    });

    test('balance below minBalance is ineligible with a reason', () => {
      const result = airdrops.checkEligibility(eligibleParticipant({ balance: 99.99 }), { now: NOW });
      expect(result.eligible).toBe(false);
      expect(result.reason).toMatch(/balance 99.99 is below the minimum of 100/);
    });

    test('accepts numeric-string balances', () => {
      const result = airdrops.checkEligibility(eligibleParticipant({ balance: '150' }), { now: NOW });
      expect(result.eligible).toBe(true);
    });

    test('transaction count below minTransactions is ineligible', () => {
      const result = airdrops.checkEligibility(eligibleParticipant({ transactionCount: 4 }), { now: NOW });
      expect(result.eligible).toBe(false);
      expect(result.reason).toMatch(/transaction count 4 is below the minimum of 5/);
    });

    test('account younger than accountAge is ineligible', () => {
      const result = airdrops.checkEligibility(
        eligibleParticipant({ accountCreatedAt: NOW - 29 * DAY_MS }),
        { now: NOW },
      );
      expect(result.eligible).toBe(false);
      expect(result.reason).toMatch(/account age .* is below the minimum of 2592000000 ms \(30 days\)/);
    });

    test('account exactly accountAge old is eligible', () => {
      const result = airdrops.checkEligibility(
        eligibleParticipant({ accountCreatedAt: NOW - 30 * DAY_MS }),
        { now: NOW },
      );
      expect(result.eligible).toBe(true);
    });

    test('accepts Date, ISO string and epoch-ms for accountCreatedAt', () => {
      const created = NOW - 90 * DAY_MS;
      for (const value of [new Date(created), new Date(created).toISOString(), created]) {
        const result = airdrops.checkEligibility(eligibleParticipant({ accountCreatedAt: value }), { now: NOW });
        expect(result.eligible).toBe(true);
      }
    });

    test('reports every failed rule in reasons, with reason as the first', () => {
      const result = airdrops.checkEligibility(
        { balance: 1, transactionCount: 0, accountCreatedAt: NOW },
        { now: NOW },
      );
      expect(result.eligible).toBe(false);
      expect(result.reasons).toHaveLength(3);
      expect(result.reason).toBe(result.reasons[0]);
      expect(result.reasons[0]).toMatch(/balance/);
      expect(result.reasons[1]).toMatch(/transaction count/);
      expect(result.reasons[2]).toMatch(/account age/);
    });

    test('missing balance is ineligible with a descriptive reason', () => {
      const result = airdrops.checkEligibility(eligibleParticipant({ balance: undefined }), { now: NOW });
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('balance is missing or not a number');
    });

    test('non-numeric transactionCount is ineligible', () => {
      const result = airdrops.checkEligibility(eligibleParticipant({ transactionCount: 'many' }), { now: NOW });
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('transactionCount is missing or not a number');
    });

    test('invalid accountCreatedAt is ineligible', () => {
      const result = airdrops.checkEligibility(eligibleParticipant({ accountCreatedAt: 'not-a-date' }), { now: NOW });
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('accountCreatedAt is missing or not a valid date');
    });

    test('missing participant is ineligible', () => {
      const result = airdrops.checkEligibility(undefined, { now: NOW });
      expect(result.eligible).toBe(false);
      expect(result.reasons).toHaveLength(3);
    });

    test('uses config-driven rules when no rules option is passed', () => {
      config.airdrops.eligibilityRules = { minBalance: 1000 };
      const result = airdrops.checkEligibility(eligibleParticipant({ balance: 500 }), { now: NOW });
      expect(result.eligible).toBe(false);
      expect(result.reason).toMatch(/minimum of 1000/);
    });

    test('explicit rules option overrides config', () => {
      config.airdrops.eligibilityRules = { minBalance: 1000 };
      const result = airdrops.checkEligibility(
        eligibleParticipant({ balance: 500 }),
        { now: NOW, rules: { minBalance: 100, minTransactions: 5, accountAge: 30 * DAY_MS } },
      );
      expect(result.eligible).toBe(true);
    });

    test('defaults "now" to Date.now() when not provided', () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        const result = airdrops.checkEligibility(eligibleParticipant({ accountCreatedAt: NOW - 1 * DAY_MS }));
        expect(result.eligible).toBe(false);
        expect(result.reason).toMatch(/account age/);
      } finally {
        Date.now = realNow;
      }
    });
  });

  describe('existing exports', () => {
    test('still exposes the pre-existing API', () => {
      for (const name of [
        'create', 'list', 'get', 'update', 'remove', 'cancel', 'addRecipients',
        'listRecipients', 'getCurrentLedger', 'scanIds', 'markExpired',
        'isValidClaim', 'validateBatchClaims', 'TERMINAL_STATUSES',
      ]) {
        expect(airdrops).toHaveProperty(name);
      }
    });
  });
});
