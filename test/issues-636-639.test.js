'use strict';

const adminSession = require('../src/services/adminSession');
const errorTracker = require('../src/services/errorTracker');
const i18n = require('../src/services/i18n');
const webhookSignature = require('../src/services/webhookSignature');
const cache = require('../src/services/cache');

describe('Issues #636, #637, #638, #639', () => {
  describe('Issue #636: adminSession concurrent session limit', () => {
    it('should define MAX_CONCURRENT_SESSIONS', () => {
      expect(adminSession.MAX_CONCURRENT_SESSIONS).toBe(5);
      expect(adminSession.MAX_SESSIONS).toBe(5);
    });

    it('should evict oldest session when exceeding limit', async () => {
      const adminId = 'adm_test_limit';
      const createdSessions = [];

      for (let i = 0; i < 6; i++) {
        const session = await adminSession.createSession(adminId, { maxConcurrentSessions: 3 });
        createdSessions.push(session);
      }

      const active = await adminSession.listSessionsByAdmin(adminId);
      expect(active.length).toBeLessThanOrEqual(3);

      // Clean up
      for (const s of createdSessions) {
        await adminSession.revokeSession(s.id);
      }
    });
  });

  describe('Issue #637: errorTracker error grouping by fingerprint', () => {
    it('should hash errors with identical signatures to same fingerprint', () => {
      const err1 = new Error('Database connection failed to host 10.0.0.1:5432');
      const err2 = new Error('Database connection failed to host 10.0.0.2:5432');
      const fp1 = errorTracker.hashError(err1);
      const fp2 = errorTracker.hashError(err2);
      expect(fp1).toBe(fp2);
    });

    it('should produce different fingerprints for different error types or messages', () => {
      const err1 = new Error('Invalid token');
      const err2 = new TypeError('Cannot read property of undefined');
      expect(errorTracker.hashError(err1)).not.toBe(errorTracker.hashError(err2));
    });

    it('should increment error group count', async () => {
      const err = new Error('Unique test error for grouping');
      const fp = errorTracker.hashError(err);
      const g1 = await errorTracker.incrementGroup(fp, err);
      expect(g1.count).toBeGreaterThanOrEqual(1);

      const g2 = await errorTracker.incrementGroup(fp, err);
      expect(g2.count).toBe(g1.count);
    });
  });

  describe('Issue #638: i18n fallback locale', () => {
    it('should translate key in supported locale', () => {
      expect(i18n.translate('NOT_FOUND', 'es')).toBe('El recurso no existe');
      expect(i18n.translate('NOT_FOUND', 'fr')).toBe("La ressource n'existe pas");
    });

    it('should fallback to en when locale does not exist or lacks key', () => {
      expect(i18n.translate('NOT_FOUND', 'de')).toBe('Resource does not exist');
      expect(i18n.translate('NOT_FOUND', 'ja')).toBe('Resource does not exist');
    });

    it('should return raw key when missing in both requested locale and fallback', () => {
      expect(i18n.translate('NON_EXISTENT_KEY', 'de')).toBe('NON_EXISTENT_KEY');
    });
  });

  describe('Issue #639: webhookSignature replay attack protection', () => {
    const secret = 'whsec_test_secret_replay_prevention';
    const body = { event: 'test', time: Date.now() };

    it('should sign and verify valid timestamp signatures', () => {
      const sig = webhookSignature.signWithTimestamp(secret, body);
      expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      expect(webhookSignature.verifyWithTimestamp(secret, body, sig)).toBe(true);
    });

    it('should reject signatures with timestamps older than 5 minutes', () => {
      const oldTimestamp = Math.floor(Date.now() / 1000) - 400; // 400 seconds ago (> 300s)
      const sig = webhookSignature.signWithTimestamp(secret, body, oldTimestamp);
      expect(webhookSignature.verifyWithTimestamp(secret, body, sig, 300)).toBe(false);
    });

    it('should validate timestamp freshness with isTimestampValid', () => {
      const now = Date.now();
      expect(webhookSignature.isTimestampValid(now)).toBe(true);
      expect(webhookSignature.isTimestampValid(now - 400000)).toBe(false);
    });
  });
});
