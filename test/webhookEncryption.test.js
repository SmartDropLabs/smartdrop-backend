'use strict';

jest.mock('../src/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

describe('webhookEncryption', () => {
  const ORIGINAL_KEY = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;

  afterEach(() => {
    if (ORIGINAL_KEY !== undefined) process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = ORIGINAL_KEY;
    else delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
    jest.resetModules();
  });

  function load() {
    jest.resetModules();
    return require('../src/services/webhookEncryption');
  }

  test('round-trips a secret through encrypt/decrypt', () => {
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = 'a-test-master-key-value';
    const { encryptSecret, decryptSecret } = load();
    const plaintext = 'whsec_abcdefabcdefabcdefabcdef';
    const encrypted = encryptSecret(plaintext);
    expect(decryptSecret(encrypted)).toBe(plaintext);
  });

  test('encrypted output does not contain the plaintext secret', () => {
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = 'a-test-master-key-value';
    const { encryptSecret } = load();
    const plaintext = 'whsec_verysecretvalue123456';
    const encrypted = encryptSecret(plaintext);
    expect(encrypted).not.toContain(plaintext);
    expect(encrypted).not.toContain('verysecretvalue');
  });

  test('two encryptions of the same secret produce different ciphertext (random IV)', () => {
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = 'a-test-master-key-value';
    const { encryptSecret } = load();
    const plaintext = 'whsec_samevalueeverytime000';
    expect(encryptSecret(plaintext)).not.toBe(encryptSecret(plaintext));
  });

  test('decrypting with the wrong key fails', () => {
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = 'key-one';
    const { encryptSecret } = load();
    const encrypted = encryptSecret('whsec_topsecret0000000000');

    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = 'key-two';
    const { decryptSecret } = load();
    expect(() => decryptSecret(encrypted)).toThrow();
  });

  test('decrypting a malformed payload throws', () => {
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = 'a-test-master-key-value';
    const { decryptSecret } = load();
    expect(() => decryptSecret('not-a-valid-payload')).toThrow(/malformed/);
  });

  test('decrypting a tampered ciphertext throws (auth tag mismatch)', () => {
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = 'a-test-master-key-value';
    const { encryptSecret, decryptSecret } = load();
    const encrypted = encryptSecret('whsec_originalvalue0000000');
    const [iv, ciphertext, tag] = encrypted.split('.');
    const tampered = [iv, Buffer.from('tampered-bytes').toString('base64'), tag].join('.');
    expect(() => decryptSecret(tampered)).toThrow();
  });

  test('falls back to an insecure dev key (and warns) when unset, but still round-trips', () => {
    delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
    const { encryptSecret, decryptSecret } = load();
    const logger = require('../src/logger');
    const plaintext = 'whsec_devmode00000000000000';
    expect(decryptSecret(encryptSecret(plaintext))).toBe(plaintext);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('insecure fixed development key'));
  });

  describe('isEncrypted', () => {
    test('recognizes an encrypted payload', () => {
      process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = 'a-test-master-key-value';
      const { encryptSecret, isEncrypted } = load();
      expect(isEncrypted(encryptSecret('whsec_abc0000000000000000'))).toBe(true);
    });

    test('does not misclassify a legacy plaintext whsec_ secret', () => {
      const { isEncrypted } = load();
      expect(isEncrypted('whsec_legacyplaintextsecret')).toBe(false);
    });

    test('rejects non-string input', () => {
      const { isEncrypted } = load();
      expect(isEncrypted(undefined)).toBe(false);
      expect(isEncrypted(null)).toBe(false);
    });
  });
});
