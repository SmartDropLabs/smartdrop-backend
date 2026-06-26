'use strict';

const http = require('http');
const {
  buildSignatureHeaders,
  sendSignedRequest,
  signPayload,
  verifySignature,
} = require('../src/services/webhook');

describe('webhook signatures', () => {
  test('signs and verifies payloads with timestamped HMAC-SHA256', () => {
    const payload = { event: 'airdrop.completed', airdrop_id: 'drop-1' };
    const timestamp = 1782345600000;
    const signature = `sha256=${signPayload('whsec_testsecret', payload, timestamp)}`;

    expect(verifySignature('whsec_testsecret', payload, signature, timestamp)).toBe(true);
    expect(verifySignature('wrong_secret', payload, signature, timestamp)).toBe(false);
  });

  test('builds SmartDrop signature and timestamp headers', () => {
    const headers = buildSignatureHeaders('whsec_testsecret', { event: 'ping' }, 1782345600000);

    expect(headers['X-SmartDrop-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(headers['X-SmartDrop-Timestamp']).toBe('1782345600000');
  });

  test('mock HTTP server receives signed request', async () => {
    let captured = null;
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        captured = {
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        res.statusCode = 204;
        res.end();
      });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      const payload = { event: 'ping', timestamp: '2026-06-25T00:00:00.000Z' };
      const result = await sendSignedRequest(
        `http://127.0.0.1:${port}/hook`,
        'whsec_testsecret',
        payload
      );

      expect(result).toMatchObject({ ok: true, status: 204 });
      expect(captured.headers['x-smartdrop-signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
      expect(captured.headers['x-smartdrop-timestamp']).toBeDefined();
      expect(verifySignature(
        'whsec_testsecret',
        captured.body,
        captured.headers['x-smartdrop-signature'],
        captured.headers['x-smartdrop-timestamp']
      )).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
