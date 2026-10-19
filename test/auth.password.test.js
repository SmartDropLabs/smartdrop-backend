'use strict';

const crypto = require('crypto');
const {
  hashPassword,
  verifyPassword,
  isBcryptHash,
  extractBcryptCost,
  getCostFactor,
  loginUser,
  registerUser,
  sanitizeUser,
} = require('../src/auth');
const AppError = require('../src/errors/AppError');

describe('Auth Password Hashing and Legacy Migration (#456)', () => {
  const plainPassword = 'CorrectHorseBatteryStaple123!';
  const wrongPassword = 'WrongPassword456!';

  test('hash is not the plaintext', async () => {
    const hash = await hashPassword(plainPassword);
    expect(hash).not.toBe(plainPassword);
    expect(isBcryptHash(hash)).toBe(true);
  });

  test('cost factor is taken from config with default of at least 12', async () => {
    const cost = getCostFactor();
    expect(cost).toBeGreaterThanOrEqual(12);

    const hash = await hashPassword(plainPassword);
    const hashCost = extractBcryptCost(hash);
    expect(hashCost).toBe(cost);
  });

  test('correct password verifies successfully', async () => {
    const hash = await hashPassword(plainPassword);
    const result = await verifyPassword(plainPassword, hash);

    expect(result.valid).toBe(true);
    expect(result.needsUpgrade).toBe(false);
  });

  test('wrong password fails verification', async () => {
    const hash = await hashPassword(plainPassword);
    const result = await verifyPassword(wrongPassword, hash);

    expect(result.valid).toBe(false);
    expect(result.needsUpgrade).toBe(false);
  });

  test('rejects passwords exceeding bcrypt 72-byte limit with clear error', async () => {
    const over72Bytes = 'A'.repeat(73);
    await expect(hashPassword(over72Bytes)).rejects.toThrow(
      'Password exceeds maximum allowed length of 72 bytes'
    );

    // Verify should also fail safely for over-length input
    const result = await verifyPassword(over72Bytes, '$2b$12$somehashhere');
    expect(result.valid).toBe(false);
  });

  test('legacy-format upgrade on login (SHA-256 hash upgraded to bcrypt)', async () => {
    // Existing user in database with weak legacy SHA-256 hash
    const legacySha256 = crypto
      .createHash('sha256')
      .update(plainPassword)
      .digest('hex');

    let updatedHash = null;
    const mockUserStore = {
      findByEmail: jest.fn(async () => ({
        id: 'usr_123',
        email: 'user@example.com',
        password_hash: legacySha256,
      })),
      update: jest.fn(async (id, data) => {
        updatedHash = data.password_hash;
        return { id, ...data };
      }),
    };

    const user = await loginUser('user@example.com', plainPassword, mockUserStore);

    expect(user.id).toBe('usr_123');
    // Lazy upgrade was triggered and persisted
    expect(mockUserStore.update).toHaveBeenCalledTimes(1);
    expect(updatedHash).not.toBeNull();
    expect(isBcryptHash(updatedHash)).toBe(true);
  });

  test('legacy-format upgrade on login (plaintext legacy password upgraded to bcrypt)', async () => {
    let updatedHash = null;
    const mockUserStore = {
      findByEmail: jest.fn(async () => ({
        id: 'usr_456',
        email: 'legacy@example.com',
        password_hash: plainPassword, // stored as plaintext legacy format
      })),
      update: jest.fn(async (id, data) => {
        updatedHash = data.password_hash;
        return { id, ...data };
      }),
    };

    const user = await loginUser('legacy@example.com', plainPassword, mockUserStore);

    expect(user.id).toBe('usr_456');
    expect(mockUserStore.update).toHaveBeenCalledTimes(1);
    expect(isBcryptHash(updatedHash)).toBe(true);
  });

  test('no response includes the password hash or raw password', async () => {
    const mockUserStore = {
      findByEmail: jest.fn(async () => null),
      create: jest.fn(async (data) => ({ id: 'usr_789', ...data })),
    };

    const registered = await registerUser(
      { email: 'new@example.com', password: plainPassword },
      mockUserStore
    );

    expect(registered).toHaveProperty('id');
    expect(registered).toHaveProperty('email');
    expect(registered.password).toBeUndefined();
    expect(registered.password_hash).toBeUndefined();
    expect(registered.passwordHash).toBeUndefined();

    // Also verify sanitizeUser directly
    const rawUser = {
      id: '123',
      email: 'test@example.com',
      password: 'raw',
      password_hash: 'hash',
      salt: 'salt',
      secret: 'secret',
    };
    const sanitized = sanitizeUser(rawUser);
    expect(sanitized).toEqual({ id: '123', email: 'test@example.com' });
  });

  test('login does not reveal whether account exists through different error messages', async () => {
    const mockUserStore = {
      findByEmail: jest.fn(async (email) => {
        if (email === 'existing@example.com') {
          return {
            id: 'usr_exist',
            email: 'existing@example.com',
            password_hash: await hashPassword(plainPassword),
          };
        }
        return null; // Nonexistent
      }),
    };

    // Non-existent user login attempt
    let nonExistentError;
    try {
      await loginUser('nonexistent@example.com', plainPassword, mockUserStore);
    } catch (err) {
      nonExistentError = err;
    }

    // Existing user with wrong password attempt
    let wrongPasswordError;
    try {
      await loginUser('existing@example.com', wrongPassword, mockUserStore);
    } catch (err) {
      wrongPasswordError = err;
    }

    expect(nonExistentError).toBeInstanceOf(AppError);
    expect(wrongPasswordError).toBeInstanceOf(AppError);
    expect(nonExistentError.statusCode).toBe(401);
    expect(wrongPasswordError.statusCode).toBe(401);
    expect(nonExistentError.code).toBe('UNAUTHORIZED');
    expect(wrongPasswordError.code).toBe('UNAUTHORIZED');
    expect(nonExistentError.message).toBe(wrongPasswordError.message);
    expect(nonExistentError.message).toBe('Invalid credentials');
  });
});
