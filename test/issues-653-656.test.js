'use strict';

const { headerSecurityMiddleware } = require('../src/middleware/headerSecurity');
const { API_CSP_DIRECTIVES, DOCS_CSP_DIRECTIVES, cspMiddleware } = require('../src/middleware/csp');
const { isValidMime, verifyFileContent } = require('../src/middleware/contentTypeValidation');
const { checkStringLengths } = require('../src/middleware/inputLength');

describe('Issues #653 - #656 Tests', () => {
  describe('Issue #653: headerSecurity HSTS header', () => {
    it('sets Strict-Transport-Security header', () => {
      const headers = {};
      const res = {
        setHeader: (k, v) => { headers[k] = v; },
      };
      headerSecurityMiddleware({}, res, () => {});
      expect(headers['Strict-Transport-Security']).toBe('max-age=31536000; includeSubDomains');
    });
  });

  describe('Issue #654: csp report-uri inclusion', () => {
    it('includes report-uri in directives and middleware', () => {
      expect(API_CSP_DIRECTIVES['report-uri']).toEqual(['/api/csp-report']);
      expect(DOCS_CSP_DIRECTIVES).toContain('report-uri /api/csp-report');

      const headers = {};
      const res = {
        setHeader: (k, v) => { headers[k] = v; },
      };
      cspMiddleware({}, res, () => {});
      expect(headers['Content-Security-Policy']).toContain('report-uri /api/csp-report');
    });
  });

  describe('Issue #655: contentTypeValidation MIME magic check', () => {
    it('verifies magic numbers for image and pdf content', () => {
      const pngBuffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      const fakePngBuffer = Buffer.from('NOT A REAL PNG FILE');

      expect(isValidMime(pngBuffer, 'image/png')).toBe(true);
      expect(isValidMime(fakePngBuffer, 'image/png')).toBe(false);

      expect(() => verifyFileContent({ buffer: pngBuffer, mimetype: 'image/png' })).not.toThrow();
      expect(() => verifyFileContent({ buffer: fakePngBuffer, mimetype: 'image/png' })).toThrow(/mismatch/i);
    });
  });

  describe('Issue #656: inputLength Unicode normalization', () => {
    it('normalizes Unicode characters before length check', () => {
      // Combining character sequence vs precomposed character
      const baseStr = 'e\u0301'; // 'é' as combining sequence (length 2 in JS string)
      const errors = checkStringLengths({ memo: baseStr.repeat(15) }, 'body'); // 30 code units, but normalized length is 15 <= 28
      expect(errors).toHaveLength(0);

      // Oversized string
      const longStr = 'a'.repeat(29);
      const longErrors = checkStringLengths({ memo: longStr }, 'body');
      expect(longErrors.length).toBeGreaterThan(0);
    });
  });
});
