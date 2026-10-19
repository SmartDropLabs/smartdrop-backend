'use strict';

const AppError = require('../errors/AppError');
const logger = require('../logger');
const {
  hashPassword,
  verifyPassword,
  dummyVerify,
  validatePasswordLength,
  validatePasswordComplexity,
} = require('./password');
const { defaultLockout } = require('./accountLockout');

/**
 * Sanitize a user object so passwords, hashes, salts, and secrets are NEVER returned.
 */
function sanitizeUser(user) {
  if (!user || typeof user !== 'object') return null;
  const {
    password,
    password_hash,
    passwordHash,
    salt,
    secret,
    ...safeUser
  } = user;
  return safeUser;
}

/**
 * Register a new user with a bcrypt-hashed password.
 *
 * @param {Object} params
 * @param {string} params.email
 * @param {string} params.username
 * @param {string} params.password
 * @param {Object} userStore - Storage repository with findByEmail, findByUsername, create
 * @returns {Promise<Object>} Sanitized user record
 */
async function registerUser({ email, username, password }, userStore) {
  validatePasswordLength(password);
  validatePasswordComplexity(password);

  if (userStore.findByEmail && (await userStore.findByEmail(email))) {
    throw new AppError('CONFLICT', 'User already exists', 409);
  }
  if (username && userStore.findByUsername && (await userStore.findByUsername(username))) {
    throw new AppError('CONFLICT', 'User already exists', 409);
  }

  const hashedPassword = await hashPassword(password);
  const now = new Date().toISOString();

  const userRecord = await userStore.create({
    email,
    username: username || email,
    password_hash: hashedPassword,
    created_at: now,
    updated_at: now,
  });

  return sanitizeUser(userRecord);
}

/**
 * Authenticate a user with constant-time comparison and lazy upgrade of legacy passwords.
 *
 * Security requirements:
 * 1. Does NOT reveal whether the account exists (uses identical error message and dummy verify).
 * 2. Compares passwords using constant-time algorithms.
 * 3. Transparently upgrades legacy hashes/plaintext to bcrypt on successful authentication.
 * 4. Never logs or echoes password or hash values.
 * 5. Prevents brute force attacks with account lockout after repeated failures (#573).
 *
 * @param {string} identifier - Email or username
 * @param {string} password - Raw password input
 * @param {Object} userStore - Storage repository with findByIdentifier / findByEmail and update
 * @returns {Promise<Object>} Sanitized user record
 */
async function loginUser(identifier, password, userStore) {
  // Generic error to avoid account enumeration
  const invalidCredentialsError = new AppError(
    'UNAUTHORIZED',
    'Invalid credentials',
    401
  );

  if (!identifier || !password) {
    throw invalidCredentialsError;
  }

  // Check brute force lockout (#573)
  const lockoutStatus = defaultLockout.isLocked(identifier);
  if (lockoutStatus.locked) {
    logger.warn('Login attempt on locked account', {
      identifier,
      lockedUntil: lockoutStatus.lockedUntil,
    });
    throw invalidCredentialsError;
  }

  // Look up user
  let user = null;
  if (typeof userStore.findByIdentifier === 'function') {
    user = await userStore.findByIdentifier(identifier);
  } else if (typeof userStore.findByEmail === 'function') {
    user = await userStore.findByEmail(identifier);
  }

  // If user does not exist, run dummy verification to equalize response timing
  if (!user || !user.password_hash) {
    await dummyVerify(password);
    defaultLockout.recordFailure(identifier);
    throw invalidCredentialsError;
  }

  // Verify password against stored hash/format
  const { valid, needsUpgrade } = await verifyPassword(password, user.password_hash);

  if (!valid) {
    logger.warn('Failed login attempt', { identifier });
    defaultLockout.recordFailure(identifier);
    throw invalidCredentialsError;
  }

  // Successful login - reset failed attempts
  defaultLockout.recordSuccess(identifier);

  // Lazy upgrade: if password was stored in legacy format or lower cost factor,
  // rehash with bcrypt and persist.
  if (needsUpgrade && typeof userStore.update === 'function') {
    try {
      const upgradedHash = await hashPassword(password);
      await userStore.update(user.id, {
        password_hash: upgradedHash,
        updated_at: new Date().toISOString(),
      });
      logger.info('Upgraded user password to bcrypt', { userId: user.id });
    } catch (upgradeErr) {
      // Do not fail the user's login if background re-hash persistence fails
      logger.error('Failed to save upgraded bcrypt password', {
        userId: user.id,
        error: upgradeErr.message,
      });
    }
  }

  return sanitizeUser(user);
}

/**
 * Change / reset a user's password.
 *
 * @param {string} userId
 * @param {string} currentPassword
 * @param {string} newPassword
 * @param {Object} userStore
 * @returns {Promise<Object>} Sanitized user record
 */
async function changePassword(userId, currentPassword, newPassword, userStore) {
  const user = await userStore.findById(userId);
  if (!user) {
    throw new AppError('NOT_FOUND', 'User not found', 404);
  }

  const { valid } = await verifyPassword(currentPassword, user.password_hash);
  if (!valid) {
    throw new AppError('UNAUTHORIZED', 'Current password is incorrect', 401);
  }

  validatePasswordLength(newPassword);
  validatePasswordComplexity(newPassword);
  const newHash = await hashPassword(newPassword);

  const updated = await userStore.update(userId, {
    password_hash: newHash,
    updated_at: new Date().toISOString(),
  });

  // Invalidate all sessions so any compromised session can no longer be used (#554).
  try {
    await invalidateAllUserSessions(userId);
  } catch (err) {
    logger.warn('Failed to invalidate user sessions after password change', {
      userId,
      error: err.message,
    });
  }

  return sanitizeUser(updated);
}

const {
  createTokenPair,
  refreshTokens,
  revokeRefreshToken,
} = require('./tokenRefresh');

const { invalidateAllUserSessions } = require('./session');

module.exports = {
  changePassword,
  loginUser,
  registerUser,
  sanitizeUser,
  createTokenPair,
  refreshTokens,
  revokeRefreshToken,
};

