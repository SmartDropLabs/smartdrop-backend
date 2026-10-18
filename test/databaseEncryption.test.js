'use strict';

const {
  encrypt,
  decrypt,
  isEncrypted,
  encryptRecord,
  decryptRecord,
  encryptRows,
  decryptRows,
  hashBlindIndex,
  deriveKey,
} = require('../src/database/encryption');

describe('Database Encryption at Rest (#519)', () => {
  describe('Basic Encryption & Decryption', () => {
    test('encrypts string and decrypts back to original', () => {
      const plaintext = 'sk_live_super_secret_stellar_key_12345';
      const encrypted = encrypt(plaintext);

      expect(isEncrypted(encrypted)).toBe(true);
      expect(encrypted).toMatch(/^enc:v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
      expect(encrypted).not.toContain(plaintext);

      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    test('isEncrypted identifies encrypted vs plaintext values', () => {
      expect(isEncrypted('enc:v1:abc:def:ghi')).toBe(true);
      expect(isEncrypted('plain-secret-123')).toBe(false);
      expect(isEncrypted(null)).toBe(false);
      expect(isEncrypted(undefined)).toBe(false);
      expect(isEncrypted(12345)).toBe(false);
    });

    test('encrypting already encrypted value returns it unchanged', () => {
      const encrypted = encrypt('my-secret');
      const doubleEncrypted = encrypt(encrypted);
      expect(doubleEncrypted).toBe(encrypted);
    });

    test('decrypting unencrypted legacy value returns it untouched (migration safe)', () => {
      const legacyValue = 'legacy_plaintext_value';
      expect(decrypt(legacyValue)).toBe(legacyValue);
      expect(decrypt(null)).toBeNull();
      expect(decrypt(undefined)).toBeUndefined();
    });

    test('encrypts and decrypts JSON objects with parseJson: true', () => {
      const obj = { account: 'GBXXX', secretSeed: 'SXXXX', balance: 500 };
      const encrypted = encrypt(obj);

      const decryptedStr = decrypt(encrypted);
      expect(typeof decryptedStr).toBe('string');

      const decryptedObj = decrypt(encrypted, { parseJson: true });
      expect(decryptedObj).toEqual(obj);
    });

    test('fails decryption if ciphertext is tampered with (auth tag validation)', () => {
      const encrypted = encrypt('sensitive-bank-account');
      const parts = encrypted.split(':');
      // parts: ['enc', 'v1', iv, ciphertext, authTag]
      // tamper with ciphertext
      const tamperedCiphertext = Buffer.from('corrupted-data').toString('base64');
      parts[3] = tamperedCiphertext;
      const tampered = parts.join(':');

      expect(() => decrypt(tampered)).toThrow();
    });

    test('supports custom key override', () => {
      const key1 = 'custom-key-alpha-123';
      const key2 = 'custom-key-beta-456';
      const secret = 'custom-secret-data';

      const encrypted = encrypt(secret, { key: key1 });
      expect(decrypt(encrypted, { key: key1 })).toBe(secret);
      expect(() => decrypt(encrypted, { key: key2 })).toThrow();
    });
  });

  describe('Record & Row Field-Level Encryption', () => {
    test('encrypts and decrypts specified fields in a database row', () => {
      const row = {
        id: 'usr_1',
        username: 'alice',
        email: 'alice@example.com',
        private_key: 'S_ALICE_SECRET_KEY',
        created_at: '2026-01-01T00:00:00Z',
      };

      const encryptedRow = encryptRecord(row, ['email', 'private_key']);

      // Plaintext fields untouched
      expect(encryptedRow.id).toBe('usr_1');
      expect(encryptedRow.username).toBe('alice');
      expect(encryptedRow.created_at).toBe('2026-01-01T00:00:00Z');

      // Sensitive fields encrypted
      expect(isEncrypted(encryptedRow.email)).toBe(true);
      expect(isEncrypted(encryptedRow.private_key)).toBe(true);
      expect(encryptedRow.email).not.toContain('alice@example.com');
      expect(encryptedRow.private_key).not.toContain('S_ALICE_SECRET_KEY');

      // Decrypt specified fields
      const decryptedRow = decryptRecord(encryptedRow, ['email', 'private_key']);
      expect(decryptedRow).toEqual(row);
    });

    test('decryptRecord automatically decrypts any encrypted fields when field list is omitted', () => {
      const row = {
        id: 'wh_1',
        url: 'https://example.com/webhook',
        secret: encrypt('whsec_test_secret_abc'),
        token: encrypt('bearer_token_xyz'),
      };

      const decrypted = decryptRecord(row);
      expect(decrypted.secret).toBe('whsec_test_secret_abc');
      expect(decrypted.token).toBe('bearer_token_xyz');
      expect(decrypted.url).toBe('https://example.com/webhook');
    });

    test('encryptRows and decryptRows handle collections of rows', () => {
      const rows = [
        { id: 1, secret: 'secret-1', public: 'pub-1' },
        { id: 2, secret: 'secret-2', public: 'pub-2' },
      ];

      const encryptedRows = encryptRows(rows, ['secret']);
      expect(isEncrypted(encryptedRows[0].secret)).toBe(true);
      expect(isEncrypted(encryptedRows[1].secret)).toBe(true);
      expect(encryptedRows[0].public).toBe('pub-1');

      const decryptedRows = decryptRows(encryptedRows, ['secret']);
      expect(decryptedRows).toEqual(rows);
    });
  });

  describe('Blind Indexing for Searchable Encryption', () => {
    test('produces deterministic HMAC-SHA256 hash for searchable encrypted fields', () => {
      const email = 'User.Name@Example.COM';
      const hash1 = hashBlindIndex(email, 'user_email');
      const hash2 = hashBlindIndex('user.name@example.com', 'user_email'); // case-insensitive match

      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
      expect(hash1).toBe(hash2);

      const differentEmailHash = hashBlindIndex('other@example.com', 'user_email');
      expect(differentEmailHash).not.toBe(hash1);
    });

    test('returns null for null/undefined input', () => {
      expect(hashBlindIndex(null)).toBeNull();
      expect(hashBlindIndex(undefined)).toBeNull();
    });
  });
});
