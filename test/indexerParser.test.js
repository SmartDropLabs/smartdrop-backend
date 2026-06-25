'use strict';

const { nativeToScVal, xdr } = require('stellar-sdk');
const { EVENT_NAMES, parseContractEvent } = require('../src/indexer/eventParser');

function sym(value) {
  return nativeToScVal(value, { type: 'symbol' });
}

function scVal(value) {
  if (Array.isArray(value)) return xdr.ScVal.scvVec(value.map(scVal));
  return nativeToScVal(value);
}

function topic(value) {
  return typeof value === 'string' && EVENT_NAMES.includes(value) ? sym(value) : scVal(value);
}

function event(topics, value, overrides = {}) {
  return {
    id: overrides.id || 'evt-1',
    type: 'contract',
    ledger: overrides.ledger || 123,
    ledgerClosedAt: '2026-06-25T00:00:00Z',
    pagingToken: '123-1',
    inSuccessfulContractCall: true,
    topic: topics.map(topic),
    value: scVal(value),
    ...overrides,
  };
}

describe('Soroban contract event parser', () => {
  test('decodes airdrop_created events with full array payload', () => {
    const parsed = parseContractEvent(event(['airdrop_created'], [
      'drop-1',
      'GCREATOR11111111111111111111111111111111111111111111111',
      'USDC',
      1000n,
      456n,
    ]));

    expect(parsed.event_name).toBe('airdrop_created');
    expect(parsed.data).toMatchObject({
      airdrop_id: 'drop-1',
      creator: 'GCREATOR11111111111111111111111111111111111111111111111',
      token: 'USDC',
      total_amount: '1000',
      expiry_ledger: '456',
    });
    expect(parsed.raw_xdr.value).toEqual(expect.any(String));
  });

  test('uses topic hints when IDs are emitted as topics', () => {
    const parsed = parseContractEvent(event(['recipient_added', 'drop-1', 'GRECIPIENT1111111111111111111111111111111111111111111'], [250n]));

    expect(parsed.event_name).toBe('recipient_added');
    expect(parsed.data).toMatchObject({
      airdrop_id: 'drop-1',
      recipient: 'GRECIPIENT1111111111111111111111111111111111111111111',
      amount: '250',
    });
  });

  test('decodes token_claimed events with object payloads', () => {
    const parsed = parseContractEvent(event(['token_claimed'], {
      airdrop_id: 'drop-1',
      recipient: 'GRECIPIENT1111111111111111111111111111111111111111111',
      amount: 125n,
      ledger: 789n,
    }));

    expect(parsed.data).toMatchObject({
      airdrop_id: 'drop-1',
      amount: '125',
      ledger: '789',
    });
  });

  test('decodes airdrop_expired events', () => {
    const parsed = parseContractEvent(event(['airdrop_expired', 'drop-1'], [875n]));

    expect(parsed.event_name).toBe('airdrop_expired');
    expect(parsed.data).toMatchObject({
      airdrop_id: 'drop-1',
      unclaimed_amount: '875',
    });
  });

  test('ignores unsupported contract events', () => {
    expect(parseContractEvent(event(['unrelated_event'], ['drop-1']))).toBeNull();
  });
});
