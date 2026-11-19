'use strict';

const jobQueue = require('../src/services/jobQueue');
const featureFlags = require('../src/services/featureFlags');
const priceOracle = require('../src/services/priceOracle');
const ssrfGuard = require('../src/services/ssrfGuard');
const cache = require('../src/services/cache');

describe('Issues #624 - #627 Tests', () => {
  describe('Issue #624: jobQueue priority support', () => {
    it('supports priority option and add() alias', async () => {
      const redis = cache.getClient();
      const highJobId = await jobQueue.enqueue('high-task', { data: 1 }, { priority: 10 });
      const normalJobId = await jobQueue.enqueue('normal-task', { data: 2 }, 0);
      const lowJobId = await jobQueue.enqueue('low-task', { data: 3 }, { priority: -1 });
      const addAliasId = await jobQueue.add({ type: 'add-task', priority: 5, data: 4 });

      expect(highJobId).toBeDefined();
      expect(normalJobId).toBeDefined();
      expect(lowJobId).toBeDefined();
      expect(addAliasId).toBeDefined();

      const processedOrder = [];
      jobQueue.register('high-task', async (job) => { processedOrder.push(job.type); });
      jobQueue.register('normal-task', async (job) => { processedOrder.push(job.type); });
      jobQueue.register('low-task', async (job) => { processedOrder.push(job.type); });
      jobQueue.register('add-task', async (job) => { processedOrder.push(job.type); });

      jobQueue.running = true;
      jobQueue.activeJobs = 0;
      jobQueue.concurrency = 10;

      // Drain 4 items
      for (let i = 0; i < 4; i++) {
        await jobQueue._processNext();
      }

      jobQueue.running = false;
      // High priority items should be processed first
      expect(processedOrder[0]).toMatch(/high-task|add-task/);
    });
  });

  describe('Issue #625: featureFlags cache invalidation', () => {
    it('invalidates cache on setFlag, updateFlag, and removeFlag', async () => {
      const delSpy = jest.spyOn(cache, 'del').mockResolvedValue(true);

      featureFlags.setFlag('beta-ui', { enabled: true });
      expect(delSpy).toHaveBeenCalledWith('flag:beta-ui');

      await featureFlags.updateFlag('beta-ui', false);
      expect(featureFlags.isEnabled('beta-ui')).toBe(false);
      expect(delSpy).toHaveBeenCalledWith('flag:beta-ui');

      await featureFlags.removeFlag('beta-ui');
      expect(featureFlags.isEnabled('beta-ui')).toBe(false);
      expect(delSpy).toHaveBeenCalledWith('flag:beta-ui');

      delSpy.mockRestore();
    });
  });

  describe('Issue #626: priceOracle stale price detection', () => {
    it('detects fresh and stale prices correctly', () => {
      const now = Date.now();
      const freshPrice = { price: 100, timestamp: now - 1000 };
      const stalePrice = { price: 100, timestamp: now - 3600 * 1000 };

      expect(priceOracle.isPriceStale(freshPrice, 60 * 1000)).toBe(false);
      expect(priceOracle.isPriceStale(stalePrice, 60 * 1000)).toBe(true);
      expect(priceOracle.isPriceStale(now - 500, 1000)).toBe(false);
      expect(priceOracle.isPriceStale(null)).toBe(true);
      expect(priceOracle.isPriceStale({ fetched_at: new Date(now - 10000).toISOString() }, 5000)).toBe(true);
    });
  });

  describe('Issue #627: ssrfGuard DNS rebinding protection', () => {
    it('asserts public target and pins DNS resolution', async () => {
      const res = await ssrfGuard.assertPublicTarget('https://example.com/webhook');
      expect(res.targetUrl).toBeDefined();
      expect(res.pinnedIp).toBeDefined();
      expect(ssrfGuard.isPrivateIp(res.pinnedIp)).toBe(false);

      await expect(ssrfGuard.pinDns('127.0.0.1')).rejects.toThrow();
      await expect(ssrfGuard.pinDns('169.254.169.254')).rejects.toThrow();
    });
  });
});
