'use strict';


const signature = require('../src/services/webhookSignature');

describe('webhook signature', () => {
  const secret = 'whsec_test_supersecret_value';
  const body = JSON.stringify({ event: 'pool.assets_locked', amount: 42 });

  test('sign produces a sha256= prefixed hex string', () => {
    const sig = signature.sign(secret, body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  test('verify returns true for matching body and signature', () => {
    const sig = signature.sign(secret, body);
    expect(signature.verify(secret, body, sig)).toBe(true);
  });

  test('verify returns false when body is tampered', () => {
    const sig = signature.sign(secret, body);
    const tampered = body.replace('42', '43');
    expect(signature.verify(secret, tampered, sig)).toBe(false);
  });

  test('verify returns false when signature is tampered', () => {
    const sig = signature.sign(secret, body);
    const tampered = sig.replace(/.$/, sig.endsWith('a') ? 'b' : 'a');
    expect(signature.verify(secret, body, tampered)).toBe(false);
  });

  test('verify returns false when signature lacks the prefix', () => {
    const sig = signature.sign(secret, body).replace('sha256=', '');
    expect(signature.verify(secret, body, sig)).toBe(false);
  });

  test('verify returns false for empty/wrong secret', () => {
    const sig = signature.sign(secret, body);
    expect(signature.verify('other_secret_value', body, sig)).toBe(false);
  });

  test('generateSecret produces a whsec_-prefixed token', () => {
    const s = signature.generateSecret();
    expect(s).toMatch(/^whsec_[0-9a-f]{64}$/);
  });

  test('sign accepts objects by stringifying them', () => {
    const obj = { a: 1, b: 'two' };
    const sigFromObj = signature.sign(secret, obj);
    const sigFromStr = signature.sign(secret, JSON.stringify(obj));
    expect(sigFromObj).toBe(sigFromStr);

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
