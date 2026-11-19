'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { inputLengthValidation } = require('../src/middleware/inputLength');
const { headerSecurityMiddleware } = require('../src/middleware/headerSecurity');
const { compressAuditLog } = require('../src/middleware/auditLogger');
const { errorHandler } = require('../src/middleware/errorHandler');
const AppError = require('../src/errors/AppError');

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
    send(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

describe('Middleware fixes (#709, #710, #711, #712)', () => {
  describe('#712 inputLengthValidation per-field limits', () => {
    it('enforces custom per-field limits passed via options.fields', () => {
      const mw = inputLengthValidation({ fields: { promoCode: 8 } });
      const req = { body: { promoCode: 'TOO_LONG_CODE' }, query: {}, params: {} };
      const res = createMockRes();
      const next = jest.fn();

      mw(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(400);
      expect(res.body.details[0]).toContain('promoCode');
      expect(res.body.details[0]).toContain('8');
    });

    it('allows values within custom per-field and maxStringLength limits', () => {
      const mw = inputLengthValidation({ fields: { promoCode: 12 }, maxStringLength: 20 });
      const req = { body: { promoCode: 'SAVE10', note: 'short note' }, query: {}, params: {} };
      const res = createMockRes();
      const next = jest.fn();

      mw(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('#711 headerSecurityMiddleware X-Frame-Options', () => {
    it('sets X-Frame-Options: DENY alongside Strict-Transport-Security', () => {
      const res = createMockRes();
      const next = jest.fn();

      headerSecurityMiddleware({}, res, next);

      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('#710 auditLogger gzip compression', () => {
    it('compresses an audit log file with gzip and preserves contents', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartdrop-audit-'));
      const srcPath = path.join(tmpDir, 'audit.log');
      const gzPath = `${srcPath}.gz`;
      const payload = JSON.stringify({ action: 'delete_webhook', admin: 'admin-1' }) + '\n';
      fs.writeFileSync(srcPath, payload, 'utf8');

      try {
        const outPath = await compressAuditLog(srcPath);
        expect(outPath).toBe(gzPath);
        expect(fs.existsSync(gzPath)).toBe(true);
        const decompressed = zlib.gunzipSync(fs.readFileSync(gzPath)).toString('utf8');
        expect(decompressed).toBe(payload);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('#709 errorHandler correlation ID', () => {
    it('sets X-Correlation-Id header and includes generated request_id when req.id is absent', () => {
      const req = { headers: {}, get: () => undefined, originalUrl: '/api/test', method: 'GET' };
      const res = createMockRes();

      errorHandler(new AppError('NOT_FOUND', 'Missing item', 404), req, res, jest.fn());

      expect(res.statusCode).toBe(404);
      expect(res.headers['x-correlation-id']).toBeTruthy();
      expect(res.body.error.request_id).toBe(res.headers['x-correlation-id']);
    });

    it('reuses req.id as X-Correlation-Id when present', () => {
      const req = { id: 'corr-12345', headers: {}, get: () => undefined, originalUrl: '/api/test', method: 'GET' };
      const res = createMockRes();

      errorHandler(new AppError('NOT_FOUND', 'Missing item', 404), req, res, jest.fn());

      expect(res.headers['x-correlation-id']).toBe('corr-12345');
      expect(res.body.error.request_id).toBe('corr-12345');
    });
  });
});
