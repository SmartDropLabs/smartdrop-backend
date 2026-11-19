'use strict';

const dataRetention = require('../src/services/dataRetention');
const leaderElection = require('../src/services/leaderElection');
const logRedaction = require('../src/services/logRedaction');
const webhookDispatcher = require('../src/services/webhookDispatcher');
const cache = require('../src/services/cache');

describe('Issues #632, #633, #634, #635', () => {
  describe('Issue #632: dataRetention dry-run mode', () => {
    it('should support dry-run mode without deleting records', async () => {
      const redis = cache.getClient();
      await redis.set('session:dryrun_test_1', 'dummy');

      const dryRunResult = await dataRetention.runRetention(true);
      expect(dryRunResult.dryRun).toBe(true);
      expect(typeof dryRunResult.count).toBe('number');

      // Key should still exist because it was dry-run
      const val = await redis.get('session:dryrun_test_1');
      expect(val).toBe('dummy');

      await redis.del('session:dryrun_test_1');
    });

    it('should support dry-run via options object', async () => {
      const dryRunResult = await dataRetention.runRetention({ dryRun: true });
      expect(dryRunResult.dryRun).toBe(true);
    });
  });

  describe('Issue #633: leaderElection split-brain protection with fencing tokens', () => {
    it('should issue monotonically increasing fencing tokens', async () => {
      const election = leaderElection.createLeaderElection('test_fencing_job');
      const token1 = await election.acquireFenceToken();
      const token2 = await election.acquireFenceToken();

      expect(token2).toBeGreaterThan(token1);
      expect(await election.validateFenceToken(token2)).toBe(true);
      expect(await election.validateFenceToken(token1)).toBe(false);
    });

    it('should detect split-brain if token is superseded before commit', async () => {
      const election = leaderElection.createLeaderElection('test_split_brain_job');

      await expect(
        election.executeWithFencing({ id: 1 }, async (job, token) => {
          // Simulate another node acquiring a new fence token during execution
          await election.acquireFenceToken();
          return 'done';
        })
      ).rejects.toThrow(/Split-brain detected/);
    });
  });

  describe('Issue #634: logRedaction comprehensive PII patterns', () => {
    it('should redact credit card numbers', () => {
      const raw = 'Payment card: 4111-2222-3333-4444 approved';
      const redacted = logRedaction.redactPii(raw);
      expect(redacted).not.toContain('4111-2222-3333-4444');
      expect(redacted).toContain('[REDACTED_PII]');
    });

    it('should redact SSNs', () => {
      const raw = 'SSN is 123-45-6789 here';
      const redacted = logRedaction.redactPii(raw);
      expect(redacted).not.toContain('123-45-6789');
      expect(redacted).toContain('[REDACTED_PII]');
    });

    it('should redact Stellar secret keys', () => {
      const stellarSecret = 'SCZANGBA5YHTNYVVV4C3U252E2B6P6IRKD4DNOK7T52WCXGIOZ5A2PNO';
      const raw = `Connecting with secret: ${stellarSecret}`;
      const redacted = logRedaction.redactPii(raw);
      expect(redacted).not.toContain(stellarSecret);
      expect(redacted).toContain('[REDACTED_PII]');
    });

    it('should redact emails and phone numbers', () => {
      const raw = 'Contact user@example.com or 555-867-5309';
      const redacted = logRedaction.redactPii(raw);
      expect(redacted).not.toContain('user@example.com');
      expect(redacted).not.toContain('555-867-5309');
    });
  });

  describe('Issue #635: webhookDispatcher circuit breaker for failing endpoints', () => {
    it('should provide endpoint circuit breaker', () => {
      const targetUrl = 'https://failing-partner.example.com/webhook';
      const breaker = webhookDispatcher.getEndpointBreaker(targetUrl, { failureThreshold: 3 });
      expect(breaker).toBeDefined();
      expect(breaker.state).toBe('closed');
    });

    it('should trip breaker to open when failures reach threshold', () => {
      const targetUrl = 'https://broken-service.example.com/webhook';
      const breaker = webhookDispatcher.getEndpointBreaker(targetUrl, { failureThreshold: 3 });

      breaker.recordFailure(new Error('Network error'));
      breaker.recordFailure(new Error('Network error'));
      expect(breaker.isOpen()).toBe(false);

      breaker.recordFailure(new Error('Network error'));
      expect(breaker.isOpen()).toBe(true);
    });
  });
});
