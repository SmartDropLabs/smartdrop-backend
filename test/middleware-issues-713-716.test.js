'use strict';

const { negotiateVersion } = require('../src/middleware/apiVersion');
const { cdnCache, normalizeCacheKey } = require('../src/middleware/cdnCache');
const { buildHstsHeader } = require('../src/middleware/httpsEnforcement');
const { DataAccessAuditor, maskSensitive } = require('../src/middleware/dataAccessAudit');
const logger = require('../src/logger');

function createMockRes() {
  const headers = {};
  const res = {
    statusCode: 200,
    body: null,
    headers,
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
      return res;
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

describe('Middleware fixes (#713, #714, #715, #716)', () => {
  describe('#713 apiVersion content negotiation', () => {
    it('negotiates version from Accept-Version header and query ?version=', () => {
      const reqHeader = { headers: { 'accept-version': 'v1' }, path: '/airdrops', query: {} };
      const resHeader = createMockRes();
      const nextHeader = jest.fn();
      negotiateVersion(reqHeader, resHeader, nextHeader);
      expect(reqHeader.apiVersion).toBe('1');
      expect(resHeader.headers['x-api-version']).toBe('v1');
      expect(nextHeader).toHaveBeenCalledTimes(1);

      const reqQuery = { headers: {}, path: '/airdrops', query: { version: '1' } };
      const resQuery = createMockRes();
      const nextQuery = jest.fn();
      negotiateVersion(reqQuery, resQuery, nextQuery);
      expect(reqQuery.apiVersion).toBe('1');
      expect(nextQuery).toHaveBeenCalledTimes(1);
    });

    it('rejects unsupported version in Accept-Version with 406', () => {
      const req = { headers: { 'accept-version': '99' }, path: '/airdrops', query: {} };
      const res = createMockRes();
      const next = jest.fn();
      negotiateVersion(req, res, next);
      expect(res.statusCode).toBe(406);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('#714 cdnCache key normalization', () => {
    it('normalizes mixed-case paths, trailing slashes, and query param order', () => {
      const key = normalizeCacheKey({ path: '/API/Prices/', query: { b: '2', a: '1' } });
      expect(key).toBe('/api/prices?a=1&b=2');

      const mw = cdnCache();
      const req = { path: '/API/Prices/', query: { b: '2', a: '1' } };
      const res = createMockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(res.headers['x-cache-key']).toBe('/api/prices?a=1&b=2');
      expect(res.headers['cdn-cache-control']).toBe('public, max-age=30');
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('#715 httpsEnforcement HSTS preload', () => {
    it('includes preload directive by default when not explicitly disabled', () => {
      expect(buildHstsHeader({})).toBe('max-age=31536000; includeSubDomains; preload');
    });
  });

  describe('#716 dataAccessAudit sensitive field masking', () => {
    it('masks email, phone, ssn, and nested sensitive fields in audit details', () => {
      const masked = maskSensitive({
        email: 'user@example.com',
        phone: '+15551234',
        ssn: '123-45-6789',
        nested: { token: 'secret-tok', safeField: 'visible' },
      });
      expect(masked.email).toBe('[REDACTED]');
      expect(masked.phone).toBe('[REDACTED]');
      expect(masked.ssn).toBe('[REDACTED]');
      expect(masked.nested.token).toBe('[REDACTED]');
      expect(masked.nested.safeField).toBe('visible');

      const logSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
      DataAccessAuditor.log({
        actor: 'user-1',
        action: 'read',
        resource: 'profile',
        details: { email: 'user@example.com', statusCode: 200 },
      });
      expect(logSpy).toHaveBeenCalledWith(
        '[DATA_ACCESS]',
        expect.objectContaining({
          details: { email: '[REDACTED]', statusCode: 200 },
        }),
      );
      logSpy.mockRestore();
    });
  });
});
