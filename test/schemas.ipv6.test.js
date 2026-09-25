'use strict';

const { httpUrlSchema } = require('../src/validation/schemas');

describe('httpUrlSchema IPv6 & private range SSRF validation (#332)', () => {
  const privateUrls = [
    // IPv4 RFC-1918 / Loopback / Link-Local / Unspecified / CGNAT
    'http://127.0.0.1/webhook',
    'http://10.0.0.1/webhook',
    'http://172.16.0.1/webhook',
    'http://172.31.255.255/webhook',
    'http://192.168.1.1/webhook',
    'http://169.254.169.254/latest/meta-data',
    'http://0.0.0.0:8080/webhook',
    'http://100.64.0.1/webhook',
    'http://100.127.255.255/webhook',

    // Hostnames
    'http://localhost/webhook',
    'http://service.local/webhook',

    // IPv6 Loopback & Unspecified
    'http://[::1]/webhook',
    'http://[::]/webhook',

    // IPv6 ULA (fc00::/7)
    'http://[fc00::1]/webhook',
    'http://[fd12:3456:789a::1]/webhook',

    // IPv6 Link-Local (fe80::/10)
    'http://[fe80::1]/webhook',
    'http://[febf::1]/webhook',

    // IPv6 Multicast (ff00::/8)
    'http://[ff02::1]/webhook',

    // IPv4-mapped IPv6
    'http://[::ffff:127.0.0.1]/webhook',
    'http://[::ffff:192.168.1.1]/webhook',
  ];

  test.each(privateUrls)('rejects private target: %s', (url) => {
    const result = httpUrlSchema.safeParse(url);
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/private or internal network/i);
  });

  const publicUrls = [
    'https://example.com/webhook',
    'https://api.github.com/events',
    'http://93.184.216.34/webhook',
    'https://[2606:2800:220:1:248:1893:25c8:1946]/webhook',
  ];

  test.each(publicUrls)('accepts valid public target: %s', (url) => {
    const result = httpUrlSchema.safeParse(url);
    expect(result.success).toBe(true);
    expect(result.data).toBe(url);
  });
});
