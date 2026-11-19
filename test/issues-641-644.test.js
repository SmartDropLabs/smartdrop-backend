'use strict';

const apiKeyAuditLog = require('../src/services/apiKeyAuditLog');
const airdrops = require('../src/services/airdrops');
const alerts = require('../src/services/alerts');
const dbCache = require('../src/services/dbCache');
const cache = require('../src/services/cache');

describe('Issues #641, #642, #643, #644', () => {
  describe('Issue #641: apiKeyAuditLog pruning', () => {
    it('should delete audit logs older than retention period', async () => {
      const mockTrx = jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        del: jest.fn().mockResolvedValue(5),
      }));

      const count = await apiKeyAuditLog.pruneAuditLogs(30, mockTrx);
      expect(count).toBe(5);
      expect(mockTrx).toHaveBeenCalledWith('api_key_audit_logs');
    });

    it('should reject invalid retention days', async () => {
      await expect(apiKeyAuditLog.pruneAuditLogs(0)).rejects.toThrow('greater than 0');
      await expect(apiKeyAuditLog.pruneAuditLogs(-5)).rejects.toThrow('greater than 0');
    });
  });

  describe('Issue #642: airdrops batch claims validation', () => {
    it('should validate individual claims correctly', () => {
      expect(airdrops.isValidClaim({ recipient: 'GABC123', amount: 100 })).toBe(true);
      expect(airdrops.isValidClaim({ recipient: '', amount: 100 })).toBe(false);
      expect(airdrops.isValidClaim({ recipient: 'GABC123', amount: -1 })).toBe(false);
      expect(airdrops.isValidClaim({ recipient: 'GABC123', amount: 0 })).toBe(false);
      expect(airdrops.isValidClaim(null)).toBe(false);
    });

    it('should validate batch of claims and reject on invalid claim', () => {
      const validClaims = [
        { recipient: 'GABC1', amount: 50 },
        { recipient: 'GABC2', amount: 100 },
      ];
      expect(airdrops.validateBatchClaims(validClaims)).toEqual(validClaims);

      const invalidClaims = [
        { recipient: 'GABC1', amount: 50 },
        { recipient: '', amount: 50 },
      ];
      expect(() => airdrops.validateBatchClaims(invalidClaims)).toThrow();
    });
  });

  describe('Issue #643: alerts deduplication', () => {
    it('should deduplicate repeated alerts', async () => {
      const mockAlert = {
        id: 'alrt_test_123',
        type: 'above',
        asset: 'XLM',
        threshold_usd: 0.5,
      };

      const key = alerts.getAlertDedupKey(mockAlert);
      await cache.del(key);

      const isDup1 = await alerts.isDuplicateAlert(mockAlert);
      expect(isDup1).toBe(false);

      const isDup2 = await alerts.isDuplicateAlert(mockAlert);
      expect(isDup2).toBe(true);

      // Clean up
      await cache.del(key);
    });
  });

  describe('Issue #644: dbCache invalidation on write', () => {
    it('should invalidate cache when updating record', async () => {
      const mockDb = {
        update: jest.fn().mockResolvedValue({ id: 'rec_42', status: 'updated' }),
      };

      const delSpy = jest.spyOn(cache, 'del').mockImplementation(() => Promise.resolve(1));

      const res = await dbCache.updateRecord('rec_42', { status: 'updated' }, mockDb);
      expect(mockDb.update).toHaveBeenCalledWith('rec_42', { status: 'updated' });
      expect(delSpy).toHaveBeenCalledWith('record:rec_42');

      delSpy.mockRestore();
    });

    it('should support executeWriteAndInvalidate helper', async () => {
      const delSpy = jest.spyOn(cache, 'del').mockImplementation(() => Promise.resolve(1));
      const writeOp = jest.fn().mockResolvedValue('written');

      const res = await dbCache.executeWriteAndInvalidate('custom_123', writeOp, 'item');
      expect(writeOp).toHaveBeenCalled();
      expect(delSpy).toHaveBeenCalledWith('item:custom_123');
      expect(delSpy).toHaveBeenCalledWith('record:custom_123');

      delSpy.mockRestore();
    });
  });
});
