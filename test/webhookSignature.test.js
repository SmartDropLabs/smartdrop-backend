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
  });
});
