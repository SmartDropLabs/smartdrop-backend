'use strict';

const { nativeToScVal } = require('@stellar/stellar-sdk');
const { EventPoller } = require('../src/indexer/eventPoller');

function contractEvent(overrides = {}) {
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
    ...overrides,
  };
}

// N distinct events at consecutive ledgers starting at `startLedger`, used
// to simulate a burst/backlog large enough to fill a batch of size `n`.
function contractEvents(n, startLedger) {
  return Array.from({ length: n }, (_, i) => {
    const ledger = startLedger + i;
    return contractEvent({
      id: `evt-${ledger}`,
      ledger,
      pagingToken: `${ledger}-1`,
      value: nativeToScVal({
        airdrop_id: `drop-${ledger}`,
        creator: 'GCREATOR',
        token: 'USDC',
        total_amount: 1000n,
        expiry_ledger: 500n,
      }),
    });
  });
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

  describe('truncated batch (#115)', () => {
    test('advances last_ledger only to the last processed event, not to the chain tip', async () => {
      const pollLimit = 5;
      // Simulates a real burst/backlog: exactly pollLimit events returned,
      // last event's ledger (24) is far behind the chain tip (500).
      const events = contractEvents(pollLimit, 20);
      const server = {
        getEvents: jest.fn(async () => ({ latestLedger: 500, events })),
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
        pollLimit,
        server,
        store,
        logger,
      });

      const result = await poller.pollOnce();

      // Not 500 (response.latestLedger) — that would permanently skip
      // whatever exists between ledger 24 and the tip.
      expect(store.setLastLedger).toHaveBeenCalledWith(24);
      expect(result).toMatchObject({ truncated: true, indexed_events: pollLimit });
      expect(logger.warn).toHaveBeenCalledWith(
        'SmartDrop event poll truncated by pollLimit; more events pending next cycle',
        expect.objectContaining({ pollLimit, indexed_events: pollLimit, resumed_from_ledger: 25 }),
      );
    });

    test('the next poll resumes from the last processed event, picking up previously-skippable events', async () => {
      const pollLimit = 5;
      const firstBatch = contractEvents(pollLimit, 20); // ledgers 20-24
      // Events that would have been silently skipped pre-fix: they sit
      // between the last processed ledger (24) and the previous poll's
      // chain-tip snapshot (500).
      const skippableRangeEvents = contractEvents(2, 100); // ledgers 100-101

      const server = { getEvents: jest.fn() };
      server.getEvents
        .mockImplementationOnce(async () => ({ latestLedger: 500, events: firstBatch }))
        .mockImplementationOnce(async () => ({ latestLedger: 500, events: skippableRangeEvents }));

      // Stateful store, so the second pollOnce() actually reads back what
      // the first one wrote — proves resumption across ticks, not just
      // within one call.
      let lastLedger = null;
      const store = {
        getLastLedger: jest.fn(async () => lastLedger),
        saveEvent: jest.fn(async () => {}),
        setLastLedger: jest.fn(async (ledger) => {
          lastLedger = ledger;
        }),
      };

      const poller = new EventPoller({
        enabled: true,
        contractId: 'CCONTRACT',
        startLedger: 10,
        pollLimit,
        server,
        store,
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      });

      const first = await poller.pollOnce();
      expect(first.truncated).toBe(true);
      expect(lastLedger).toBe(24);

      const second = await poller.pollOnce();

      // Resumed from 25 (last processed + 1), not 501 (tip + 1) — the
      // pre-fix bug would have started here at 501, skipping ledgers
      // 25-499 (including skippableRangeEvents) forever.
      expect(server.getEvents.mock.calls[1][0].startLedger).toBe(25);
      expect(second.indexed_events).toBe(2);
      expect(store.saveEvent).toHaveBeenCalledTimes(pollLimit + 2);
    });

    test('a batch smaller than pollLimit still advances to the chain tip and logs no warning', async () => {
      const pollLimit = 100;
      const events = contractEvents(3, 20);
      const server = {
        getEvents: jest.fn(async () => ({ latestLedger: 500, events })),
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
        pollLimit,
        server,
        store,
        logger,
      });

      const result = await poller.pollOnce();

      expect(store.setLastLedger).toHaveBeenCalledWith(500);
      expect(result.truncated).toBe(false);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
