'use strict';

const { getClientIp } = require('../src/utils/clientIp');

describe('getClientIp', () => {
  test('prefers the left-most x-forwarded-for hop over the socket address', () => {
    // Behind a proxy the socket address is the proxy, not the client.
    expect(
      getClientIp({
        headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
        socket: { remoteAddress: '10.0.0.1' },
      })
    ).toBe('203.0.113.9');
  });

  test('handles a repeated x-forwarded-for header (array form)', () => {
    expect(
      getClientIp({
        headers: { 'x-forwarded-for': ['198.51.100.7, 10.0.0.2', '10.0.0.3'] },
        socket: { remoteAddress: '10.0.0.2' },
      })
    ).toBe('198.51.100.7');
  });

  test('trims surrounding whitespace', () => {
    expect(getClientIp({ headers: { 'x-forwarded-for': '  198.51.100.7  ' } })).toBe('198.51.100.7');
  });

  test('falls back to the socket address when the header is absent', () => {
    expect(getClientIp({ headers: {}, socket: { remoteAddress: '203.0.113.40' } })).toBe(
      '203.0.113.40'
    );
  });

  test('falls back to req.connection for old-style request objects', () => {
    expect(getClientIp({ headers: {}, connection: { remoteAddress: '203.0.113.41' } })).toBe(
      '203.0.113.41'
    );
  });

  test('returns "unknown" when the header is empty and no socket address exists', () => {
    expect(getClientIp({ headers: { 'x-forwarded-for': '' } })).toBe('unknown');
    expect(getClientIp({})).toBe('unknown');
    expect(getClientIp(undefined)).toBe('unknown');
  });
});
