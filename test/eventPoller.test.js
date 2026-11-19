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
        saveEvents: jest.fn(async () => {}),
      advanceLastLedger: jest.fn(async () => true),
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
    expect(store.saveEvents).toHaveBeenCalledWith([expect.objectContaining({
      event_name: 'airdrop_created',
      data: expect.objectContaining({ airdrop_id: 'drop-1', total_amount: '1000' }),
    })]);
    expect(store.advanceLastLedger).toHaveBeenCalledWith(null, 25);
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
        saveEvents: jest.fn(async () => {}),
      advanceLastLedger: jest.fn(async () => true),
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
    // The cursor advance is conditional on the ledger that was actually read
    // (#341), not a blind overwrite.
    expect(store.advanceLastLedger).toHaveBeenCalledWith(19, 25);
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
        saveEvents: jest.fn(async () => {}),
        advanceLastLedger: jest.fn(async () => true),
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
      expect(store.advanceLastLedger).toHaveBeenCalledWith(null, 24);
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
        saveEvents: jest.fn(async () => {}),
        advanceLastLedger: jest.fn(async (expected, next) => {
          // Same contract as eventStore.advanceLastLedger: refuse the write
          // if the cursor no longer matches what the caller read, and never
          // move it backwards.
          if (expected !== lastLedger) return false;
          if (lastLedger !== null && next < lastLedger) return false;
          lastLedger = next;
          return true;
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
      expect(store.saveEvents).toHaveBeenCalledTimes(2);
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
        saveEvents: jest.fn(async () => {}),
        advanceLastLedger: jest.fn(async () => true),
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

      expect(store.advanceLastLedger).toHaveBeenCalledWith(null, 500);
      expect(result.truncated).toBe(false);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('concurrent cursor advance (#341)', () => {
    function buildPoller({ store, server, logger }) {
      return new EventPoller({
        enabled: true,
        contractId: 'CCONTRACT',
        startLedger: 10,
        pollLimit: 5,
        server,
        store,
        logger,
      });
    }

    test('saves the batch before touching the cursor', async () => {
      const server = {
        getEvents: jest.fn(async () => ({
          latestLedger: 25,
          events: [contractEvent()],
        })),
      };
      const store = {
        getLastLedger: jest.fn(async () => null),
        saveEvents: jest.fn(async () => {}),
        advanceLastLedger: jest.fn(async () => true),
      };

      const poller = buildPoller({
        store,
        server,
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      });
      await poller.pollOnce();

      // If the cursor moved first and the process died mid-save, those
      // events would be gone for good — hence save-then-advance.
      expect(store.saveEvents.mock.invocationCallOrder[0]).toBeLessThan(
        store.advanceLastLedger.mock.invocationCallOrder[0],
      );
    });

    test('refusing the write still persists events and reports a skip', async () => {
      const server = {
        getEvents: jest.fn(async () => ({
          latestLedger: 150,
          events: [contractEvent({ ledger: 105, id: 'evt-105' })],
        })),
      };
      const store = {
        getLastLedger: jest.fn(async () => 100),
        saveEvents: jest.fn(async () => {}),
        // Another instance moved the cursor between our read and our write.
        advanceLastLedger: jest.fn(async () => false),
      };
      const logger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      };

      const poller = buildPoller({ store, server, logger });
      const result = await poller.pollOnce();

      expect(store.advanceLastLedger).toHaveBeenCalledWith(100, 150);
      expect(store.saveEvents).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        skipped: true,
        reason: 'concurrent cursor advance',
      });
      expect(logger.warn).toHaveBeenCalledWith(
        'Ledger cursor changed concurrently; leaving the other writer in place',
        expect.objectContaining({
          expected_ledger: 100,
          attempted_ledger: 150,
        }),
      );
      expect(poller.getMetrics()).toMatchObject({
        polls_attempted: 1,
        polls_skipped: 1,
        polls_succeeded: 0,
      });
      // The loser of the race must not claim the progress it did not make.
      expect(poller.lastIndexedLedger).toBeNull();
    });
  });
});
