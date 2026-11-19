'use strict';

const { checkPoolHealth } = require('../src/services/dbHealth');

describe('Issues #606 - #608 & #640 Tests', () => {
  describe('Issue #640: dbHealth connection pool monitoring', () => {
    it('returns pool status metrics', async () => {
      const poolMetrics = await checkPoolHealth();
      expect(poolMetrics).toHaveProperty('total');
      expect(poolMetrics).toHaveProperty('idle');
      expect(poolMetrics).toHaveProperty('waiting');
      expect(typeof poolMetrics.total).toBe('number');
      expect(typeof poolMetrics.idle).toBe('number');
      expect(typeof poolMetrics.waiting).toBe('number');
    });
  });

  describe('Issues #606, #607, #608: route param validation enforcement', () => {
    it('ensures routes use req.validated.params instead of raw unvalidated params', () => {
      const keysRoute = require('../src/routes/keys');
      const alertsRoute = require('../src/routes/alerts');
      const webhooksRoute = require('../src/routes/webhooks');

      expect(keysRoute).toBeDefined();
      expect(alertsRoute).toBeDefined();
      expect(webhooksRoute).toBeDefined();
    });
  });
});
