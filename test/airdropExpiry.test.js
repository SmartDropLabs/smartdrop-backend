'use strict';

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

const mockAirdropsService = {
  getCurrentLedger: jest.fn(),
  scanIds: jest.fn(),
  get: jest.fn(),
  markExpired: jest.fn(),
  TERMINAL_STATUSES: new Set(['completed', 'failed', 'cancelled', 'expired']),
};

const mockDispatch = jest.fn();

jest.mock('../src/logger', () => mockLogger);
jest.mock('../src/services/airdrops', () => mockAirdropsService);
jest.mock('../src/services/webhookDispatcher', () => ({ dispatch: mockDispatch }));
jest.mock('../src/config', () => ({
  airdrops: {
    expiryCheckIntervalSeconds: 60,
    ledgerCacheTtlMs: 5000,
    expiryScanBatchSize: 100,
  },
}));

// scanIds() is an async generator in the real service; this mock accepts a
// plain array of batches and yields them the same way.
function mockScanIdsReturning(batches) {
  mockAirdropsService.scanIds.mockReturnValue(
    (async function* () {
      for (const batch of batches) yield batch;
    })()
  );
}

function draftAirdrop(overrides = {}) {
  return {
    id: 'drop_1',
    status: 'draft',
    expiry_ledger: 100,
    ...overrides,
  };
}

const { tick } = require('../src/jobs/airdropExpiry');

beforeEach(() => {
  jest.clearAllMocks();
  mockAirdropsService.TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'expired']);
});

describe('airdropExpiry job tick (#88)', () => {
  test('expires an airdrop past its expiry_ledger and dispatches airdrop.failed exactly once', async () => {
    mockAirdropsService.getCurrentLedger.mockResolvedValue(150);
    mockScanIdsReturning([['drop_1']]);
    mockAirdropsService.get.mockResolvedValue(draftAirdrop({ expiry_ledger: 100 }));
    mockAirdropsService.markExpired.mockResolvedValue(
      draftAirdrop({ status: 'expired', expiry_ledger: 100 })
    );

    await tick();

    expect(mockAirdropsService.markExpired).toHaveBeenCalledWith('drop_1', 150);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'airdrop.failed',
        data: expect.objectContaining({ airdrop_id: 'drop_1', reason: 'expired' }),
      })
    );
  });

  test('leaves a non-expired airdrop untouched', async () => {
    mockAirdropsService.getCurrentLedger.mockResolvedValue(50);
    mockScanIdsReturning([['drop_1']]);
    mockAirdropsService.get.mockResolvedValue(draftAirdrop({ expiry_ledger: 100 }));

    await tick();

    expect(mockAirdropsService.markExpired).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('skips an airdrop already in a terminal status without attempting a transition', async () => {
    mockAirdropsService.getCurrentLedger.mockResolvedValue(150);
    mockScanIdsReturning([['drop_1']]);
    mockAirdropsService.get.mockResolvedValue(draftAirdrop({ status: 'cancelled', expiry_ledger: 100 }));

    await tick();

    expect(mockAirdropsService.markExpired).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('does not dispatch when markExpired reports no transition happened (lost a race)', async () => {
    mockAirdropsService.getCurrentLedger.mockResolvedValue(150);
    mockScanIdsReturning([['drop_1']]);
    mockAirdropsService.get.mockResolvedValue(draftAirdrop({ expiry_ledger: 100 }));
    mockAirdropsService.markExpired.mockResolvedValue(null);

    await tick();

    expect(mockAirdropsService.markExpired).toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('is idempotent across two ticks: the webhook fires exactly once total', async () => {
    mockAirdropsService.getCurrentLedger.mockResolvedValue(150);
    mockScanIdsReturning([['drop_1']]);
    mockAirdropsService.get.mockResolvedValue(draftAirdrop({ expiry_ledger: 100 }));
    mockAirdropsService.markExpired.mockResolvedValueOnce(
      draftAirdrop({ status: 'expired', expiry_ledger: 100 })
    );

    await tick();

    // Second tick: the airdrop is now expired (terminal), matching what a
    // real second scan would see after the first tick's transition landed.
    mockScanIdsReturning([['drop_1']]);
    mockAirdropsService.get.mockResolvedValue(draftAirdrop({ status: 'expired', expiry_ledger: 100 }));

    await tick();

    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  test('a Horizon failure logs a warning and does not throw or touch any airdrop', async () => {
    mockAirdropsService.getCurrentLedger.mockRejectedValue(new Error('Horizon unreachable'));

    await expect(tick()).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Horizon unreachable'),
      expect.objectContaining({ error: 'Horizon unreachable' })
    );
    expect(mockAirdropsService.scanIds).not.toHaveBeenCalled();
    expect(mockAirdropsService.markExpired).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('a dispatch failure is logged and does not throw out of the tick', async () => {
    mockAirdropsService.getCurrentLedger.mockResolvedValue(150);
    mockScanIdsReturning([['drop_1']]);
    mockAirdropsService.get.mockResolvedValue(draftAirdrop({ expiry_ledger: 100 }));
    mockAirdropsService.markExpired.mockResolvedValue(
      draftAirdrop({ status: 'expired', expiry_ledger: 100 })
    );
    mockDispatch.mockRejectedValue(new Error('webhook target unreachable'));

    await expect(tick()).resolves.toBeUndefined();

    expect(mockLogger.error).toHaveBeenCalledWith(
      'Airdrop expiry webhook dispatch failed',
      expect.objectContaining({ airdrop_id: 'drop_1' })
    );
  });

  test('handles multiple airdrops across multiple scan batches', async () => {
    mockAirdropsService.getCurrentLedger.mockResolvedValue(150);
    mockScanIdsReturning([['drop_1'], ['drop_2']]);
    mockAirdropsService.get.mockImplementation(async (id) =>
      draftAirdrop({ id, expiry_ledger: 100 })
    );
    mockAirdropsService.markExpired.mockImplementation(async (id) =>
      draftAirdrop({ id, status: 'expired', expiry_ledger: 100 })
    );

    await tick();

    expect(mockAirdropsService.markExpired).toHaveBeenCalledTimes(2);
    expect(mockDispatch).toHaveBeenCalledTimes(2);
  });

  test('a per-airdrop read error is logged and does not stop the rest of the scan', async () => {
    mockAirdropsService.getCurrentLedger.mockResolvedValue(150);
    mockScanIdsReturning([['drop_1', 'drop_2']]);
    mockAirdropsService.get.mockImplementation(async (id) => {
      if (id === 'drop_1') throw new Error('redis timeout');
      return draftAirdrop({ id, expiry_ledger: 100 });
    });
    mockAirdropsService.markExpired.mockResolvedValue(
      draftAirdrop({ id: 'drop_2', status: 'expired', expiry_ledger: 100 })
    );

    await tick();

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('failed to read airdrop'),
      expect.objectContaining({ airdrop_id: 'drop_1' })
    );
    expect(mockAirdropsService.markExpired).toHaveBeenCalledWith('drop_2', 150);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });
});
