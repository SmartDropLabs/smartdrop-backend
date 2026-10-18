'use strict';

const {
  DEFAULT_SECURITY_HEADERS,
  securityHeadersMiddleware,
} = require('../middleware/securityHeaders');

function createMockRes() {
  const headers = new Map();
  headers.set('x-powered-by', 'Express');
  return {
    headers,
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    removeHeader(name) {
      headers.delete(name.toLowerCase());
    },
  };
}

describe('securityHeadersMiddleware (#516)', () => {
  it('sets all default OWASP security headers and removes X-Powered-By', () => {
    const middleware = securityHeadersMiddleware();
    const res = createMockRes();
    let nextCalled = false;

    middleware({}, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(res.getHeader('X-Powered-By')).toBeUndefined();
    expect(res.getHeader('X-Content-Type-Options')).toBe('nosniff');
    expect(res.getHeader('X-Frame-Options')).toBe('DENY');
    expect(res.getHeader('Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains'
    );
    expect(res.getHeader('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.getHeader('Permissions-Policy')).toBe(
      'camera=(), microphone=(), geolocation=()'
    );
    expect(res.getHeader('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(res.getHeader('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(res.getHeader('Content-Security-Policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'"
    );
  });

  it('allows overriding specific headers and disabling headers with false', () => {
    const middleware = securityHeadersMiddleware({
      'X-Frame-Options': 'SAMEORIGIN',
      'Cross-Origin-Embedder-Policy': false,
    });
    const res = createMockRes();

    middleware({}, res, () => {});

    expect(res.getHeader('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(res.getHeader('Cross-Origin-Embedder-Policy')).toBeUndefined();
    expect(res.getHeader('X-Content-Type-Options')).toBe(
      DEFAULT_SECURITY_HEADERS['X-Content-Type-Options']
    );
  });
});
