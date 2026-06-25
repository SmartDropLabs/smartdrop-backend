'use strict';

const { nativeToScVal } = require('stellar-sdk');
const { EventPoller } = require('../src/indexer/eventPoller');

function contractEvent() {
  return {
    id: 'evt-1',
    type: 'contract',
    ledger: 20,
    ledgerClosedAt: '2026-06-25T00:00:00Z',
    pagingToken: '20-1',
    inSuccessfulContractCall: true,
    topic: [nativeToScVal('airdrop_created', { type: 'symbol' })],
    value: nativeToScVal({
      airdrop_id: 'drop-1',
      creator: 'GCREATOR',
      token: 'USDC',
      total_amount: 1000n,
      expiry_ledger: 500n,
    }),
  };
}

describe('EventPoller', () => {
  test('polls Soroban RPC, stores parsed events, and advances last ledger', async () => {
    const server = {
      getEvents: jest.fn(async () => ({
        latestLedger: 25,
        events: [contractEvent()],
      })),
    };
    const store = {
      getLastLedger: jest.fn(async () => null),
      saveEvent: jest.fn(async () => {}),
      setLastLedger: jest.fn(async () => {}),
    };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

    const poller = new EventPoller({
      enabled: true,
      contractId: 'CCONTRACT',
      startLedger: 10,
      pollLimit: 5,
      server,
      store,
      logger,
    });

    const result = await poller.pollOnce();

    expect(server.getEvents).toHaveBeenCalledWith({
      startLedger: 10,
      filters: [{ type: 'contract', contractIds: ['CCONTRACT'] }],
      limit: 5,
    });
    expect(store.saveEvent).toHaveBeenCalledWith(expect.objectContaining({
      event_name: 'airdrop_created',
      data: expect.objectContaining({ airdrop_id: 'drop-1', total_amount: '1000' }),
    }));
    expect(store.setLastLedger).toHaveBeenCalledWith(25);
    expect(result).toMatchObject({ indexed_events: 1, latest_ledger: 25 });
    expect(poller.getStatus()).toMatchObject({ latest_ledger: 25, last_error: null });
  });

  test('continues from the ledger after the saved checkpoint', async () => {
    const server = {
      getEvents: jest.fn(async () => ({ latestLedger: 25, events: [] })),
    };
    const store = {
      getLastLedger: jest.fn(async () => 19),
      saveEvent: jest.fn(async () => {}),
      setLastLedger: jest.fn(async () => {}),
    };

    const poller = new EventPoller({
      enabled: true,
      contractId: 'CCONTRACT',
      startLedger: 10,
      server,
      store,
    });

    await poller.pollOnce();

    expect(server.getEvents.mock.calls[0][0].startLedger).toBe(20);
  });

  test('skips polling when no contract id is configured', async () => {
    const poller = new EventPoller({
      enabled: true,
      contractId: '',
      server: { getEvents: jest.fn() },
    });

    await expect(poller.pollOnce()).resolves.toMatchObject({ skipped: true });
  });
});
