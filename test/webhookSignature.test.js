'use strict';

const http = require('http');
const signature = require('../src/services/webhookSignature');
const {
  buildSignatureHeaders,
  sendSignedRequest,
} = require('../src/services/webhook');
const { requestContext } = require('../src/middleware/requestId');

describe('webhook signature', () => {
  const secret = 'whsec_test_supersecret_value';
  const body = JSON.stringify({ event: 'pool.assets_locked', amount: 42 });

  test('sign produces a sha256= prefixed hex string with timestamp and nonce', () => {
    const sig = signature.sign(secret, body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}; t=\d+; n=[0-9a-f]+$/);
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

  test('sign produces unique signatures per call (nonce prevents replay)', () => {
    const sig1 = signature.sign(secret, body);
    const sig2 = signature.sign(secret, body);
    expect(sig1).not.toBe(sig2);
  });

  test('verifyDetailed returns reason for expired signatures', () => {
    // Manually craft an expired signature with timestamp far in the past
    const crypto = require('crypto');
    const timestamp = Math.floor(Date.now() / 1000) - 1000;
    const nonce = 'deadbeef';
    const payload = `${timestamp}.${nonce}.${body}`;
    const digest = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const sig = `sha256=${digest}; t=${timestamp}; n=${nonce}`;
    const result = signature.verifyDetailed(secret, body, sig, { maxAgeSeconds: 300 });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('expired');
  });
});

describe('webhook signatures', () => {
  // Issue #302: webhook.js used to carry its own duplicate HMAC signing
  // implementation. It now delegates entirely to webhookSignature.js, so
  // these tests exercise webhook.js's delivery-facing wrappers and confirm
  // they produce a signature that webhookSignature.verify() itself accepts,
  // rather than re-testing the signing algorithm a second time.
  test('signs payloads such that webhookSignature.verify() accepts them', () => {
    const payload = { event: 'airdrop.completed', airdrop_id: 'drop-1' };
    const headers = buildSignatureHeaders('whsec_testsecret', payload);

    expect(signature.verify('whsec_testsecret', payload, headers['X-SmartDrop-Signature'])).toBe(true);
    expect(signature.verify('wrong_secret', payload, headers['X-SmartDrop-Signature'])).toBe(false);
  });

  test('builds SmartDrop signature headers matching webhookSignature.js\'s format', () => {
    const headers = buildSignatureHeaders('whsec_testsecret', { event: 'ping' });

    expect(headers['X-SmartDrop-Signature']).toMatch(/^sha256=[0-9a-f]{64}; t=\d+; n=[0-9a-f]+$/);
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
      const result = await requestContext.run(
        { requestId: 'req_webhook_123' },
        () => sendSignedRequest(
          `http://127.0.0.1:${port}/hook`,
          'whsec_testsecret',
          payload
        )
      );

      expect(result).toMatchObject({ ok: true, status: 204 });
      expect(captured.headers['x-request-id']).toBe('req_webhook_123');
      expect(captured.headers['x-smartdrop-signature']).toMatch(
        /^sha256=[0-9a-f]{64}; t=\d+; n=[0-9a-f]+$/,
      );
      expect(
        signature.verify('whsec_testsecret', captured.body, captured.headers['x-smartdrop-signature']),
      ).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
