'use strict';

/**
 * Token Refresh Mechanism (#521).
 *
 * Implements access token refresh with Refresh Token Rotation (RTR)
 * and automatic reuse detection according to OAuth 2.0 Security Best Current Practices:
 * 1. Generates short-lived JWT access tokens and cryptographically random refresh tokens.
 * 2. Stores hashed refresh tokens (SHA-256) in cache/store with expiration.
 * 3. Rotates refresh tokens on each refresh: the old token is invalidated and a fresh
 *    pair is returned.
 * 4. Reuse Detection: If an already-rotated/invalidated token is used again, the entire
 *    token family for that user is immediately revoked to protect against token theft.
 */

const crypto = require('crypto');
const cache = require('../services/cache');
const logger = require('../logger');
const AppError = require('../errors/AppError');
const { base64UrlEncode } = require('../middleware/jwtAuth');

// Defaults
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 900; // 15 minutes
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 3600; // 7 days
const REFRESH_PREFIX = 'rt:';
const FAMILY_PREFIX = 'rt_fam:';

// In-memory fallback store when Redis is unavailable (e.g. unit tests)
const memoryStore = new Map();
const memoryFamilyStore = new Map();

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Sign a JWT using HMAC-SHA256.
 *
 * @param {Object} payload - Token claims
 * @param {string} secret - Signing secret
 * @param {Object} [options]
 * @param {number} [options.expiresInSeconds=900]
 * @param {string} [options.issuer='smartdrop-api']
 * @param {string} [options.audience='smartdrop-client']
 * @param {string} [options.algorithm='HS256']
 * @returns {string} JWT string
 */
function signJwt(payload, secret, options = {}) {
  const {
    expiresInSeconds = DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
    issuer = 'smartdrop-api',
    audience = 'smartdrop-client',
    algorithm = 'HS256',
  } = options;

  if (!secret) {
    throw new Error('signJwt: secret is required');
  }

  const header = { alg: algorithm, typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);

  const fullPayload = {
    ...payload,
    iat: now,
    nbf: now,
    exp: now + expiresInSeconds,
    iss: issuer,
    aud: audience,
  };

  const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(fullPayload)));
  const data = `${headerB64}.${payloadB64}`;

  const hashAlg = algorithm === 'HS384' ? 'sha384' : algorithm === 'HS512' ? 'sha512' : 'sha256';
  const sig = crypto.createHmac(hashAlg, secret).update(data).digest();
  const sigB64 = base64UrlEncode(sig);

  return `${data}.${sigB64}`;
}

/**
 * Generate a new cryptographically random raw refresh token.
 */
function generateRawRefreshToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Store a refresh token record.
 */
async function storeRefreshToken(record, ttlSeconds) {
  const key = `${REFRESH_PREFIX}${record.tokenHash}`;
  const data = JSON.stringify(record);

  try {
    if (typeof cache.isConnected === 'function' && cache.isConnected()) {
      const client = cache.getClient();
      if (client && typeof client.set === 'function') {
        await client.set(key, data, 'EX', ttlSeconds);
        // Track family tokens for reuse detection revocation
        if (record.familyId) {
          const familyKey = `${FAMILY_PREFIX}${record.familyId}`;
          if (typeof client.sadd === 'function') {
            await client.sadd(familyKey, record.tokenHash);
            await client.expire(familyKey, ttlSeconds);
          }
        }
        return;
      }
    }
  } catch (err) {
    logger.debug('Redis store failed, using in-memory token store', { error: err.message });
  }

  // Memory fallback
  memoryStore.set(key, record);
  if (record.familyId) {
    if (!memoryFamilyStore.has(record.familyId)) {
      memoryFamilyStore.set(record.familyId, new Set());
    }
    memoryFamilyStore.get(record.familyId).add(record.tokenHash);
  }
}

/**
 * Retrieve a refresh token record by its hash.
 */
async function getRefreshTokenRecord(tokenHash) {
  const key = `${REFRESH_PREFIX}${tokenHash}`;

  try {
    if (typeof cache.isConnected === 'function' && cache.isConnected()) {
      const client = cache.getClient();
      if (client && typeof client.get === 'function') {
        const val = await client.get(key);
        if (val) {
          return typeof val === 'string' ? JSON.parse(val) : val;
        }
        return null;
      }
    }
  } catch (err) {
    logger.debug('Redis get failed, checking memory store', { error: err.message });
  }

  return memoryStore.get(key) || null;
}

/**
 * Delete / invalidate a refresh token record.
 */
async function deleteRefreshToken(tokenHash) {
  const key = `${REFRESH_PREFIX}${tokenHash}`;

  try {
    if (typeof cache.isConnected === 'function' && cache.isConnected()) {
      const client = cache.getClient();
      if (client && typeof client.del === 'function') {
        await client.del(key);
      }
    }
  } catch (err) {
    logger.debug('Redis del failed', { error: err.message });
  }

  memoryStore.delete(key);
}

/**
 * Revoke all tokens belonging to a family (token reuse defense).
 */
async function revokeFamily(familyId) {
  if (!familyId) return;
  logger.warn('Revoking token family due to detected reuse', { familyId });

  try {
    if (typeof cache.isConnected === 'function' && cache.isConnected()) {
      const client = cache.getClient();
      if (client && typeof client.smembers === 'function') {
        const familyKey = `${FAMILY_PREFIX}${familyId}`;
        const hashes = await client.smembers(familyKey);
        if (Array.isArray(hashes)) {
          for (const hash of hashes) {
            await client.del(`${REFRESH_PREFIX}${hash}`);
          }
        }
        await client.del(familyKey);
      }
    }
  } catch (err) {
    logger.debug('Redis family revocation failed', { error: err.message });
  }

  // Memory fallback
  if (memoryFamilyStore.has(familyId)) {
    for (const hash of memoryFamilyStore.get(familyId)) {
      memoryStore.delete(`${REFRESH_PREFIX}${hash}`);
    }
    memoryFamilyStore.delete(familyId);
  }
}

/**
 * Create a new access and refresh token pair for a user.
 *
 * @param {Object} user - User object (must have id)
 * @param {Object} options
 * @param {string} [options.jwtSecret] - Secret for signing JWT
 * @param {number} [options.accessTokenTtlSeconds=900]
 * @param {number} [options.refreshTokenTtlSeconds=604800]
 * @param {string} [options.familyId] - Existing family ID if rotating
 * @returns {Promise<Object>} Token pair and metadata
 */
async function createTokenPair(user, options = {}) {
  if (!user || !user.id) {
    throw new AppError('INTERNAL_ERROR', 'createTokenPair: user with id is required', 500);
  }

  const {
    jwtSecret = process.env.JWT_SECRET || 'smartdrop-dev-jwt-secret-do-not-use-in-production',
    accessTokenTtlSeconds = DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds = DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
    familyId = crypto.randomUUID(),
    scopes = user.scopes || ['default'],
  } = options;

  // 1. Sign access token
  const accessPayload = {
    sub: user.id,
    userId: user.id,
    email: user.email,
    username: user.username,
    scopes,
  };
  const accessToken = signJwt(accessPayload, jwtSecret, {
    expiresInSeconds: accessTokenTtlSeconds,
  });

  // 2. Generate refresh token
  const rawRefreshToken = generateRawRefreshToken();
  const tokenHash = hashToken(rawRefreshToken);
  const now = Date.now();
  const expiresAt = now + refreshTokenTtlSeconds * 1000;

  const record = {
    tokenId: crypto.randomUUID(),
    tokenHash,
    userId: user.id,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      scopes,
    },
    familyId,
    createdAt: now,
    expiresAt,
    used: false,
  };

  await storeRefreshToken(record, refreshTokenTtlSeconds);

  return {
    tokenType: 'Bearer',
    accessToken,
    refreshToken: rawRefreshToken,
    expiresIn: accessTokenTtlSeconds,
    refreshExpiresIn: refreshTokenTtlSeconds,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
    },
  };
}

/**
 * Refresh an access token using a valid refresh token.
 * Performs Refresh Token Rotation (RTR) and detects reuse.
 *
 * @param {string} rawRefreshToken
 * @param {Object} [options]
 * @returns {Promise<Object>} New token pair
 */
async function refreshTokens(rawRefreshToken, options = {}) {
  if (!rawRefreshToken || typeof rawRefreshToken !== 'string') {
    throw new AppError('UNAUTHORIZED', 'Refresh token is required', 401);
  }

  const tokenHash = hashToken(rawRefreshToken.trim());
  const record = await getRefreshTokenRecord(tokenHash);

  // If token record doesn't exist
  if (!record) {
    throw new AppError('UNAUTHORIZED', 'Invalid or expired refresh token', 401);
  }

  // Reuse Detection: If this token was already marked as used, compromise detected!
  if (record.used) {
    await revokeFamily(record.familyId);
    throw new AppError(
      'UNAUTHORIZED',
      'Invalid refresh token: token reuse detected. All sessions in this chain have been terminated.',
      401
    );
  }

  // Expiration check
  if (Date.now() > record.expiresAt) {
    await deleteRefreshToken(tokenHash);
    throw new AppError('UNAUTHORIZED', 'Refresh token has expired', 401);
  }

  // Invalidate old token immediately to prevent reuse
  record.used = true;
  await storeRefreshToken(record, 60); // Keep for a short grace window to detect reuse

  // Issue new token pair preserving the familyId
  const newPair = await createTokenPair(record.user, {
    familyId: record.familyId,
    ...options,
  });

  return newPair;
}

/**
 * Revoke a single refresh token (e.g. on user logout).
 *
 * @param {string} rawRefreshToken
 */
async function revokeRefreshToken(rawRefreshToken) {
  if (!rawRefreshToken) return false;
  const tokenHash = hashToken(rawRefreshToken.trim());
  const record = await getRefreshTokenRecord(tokenHash);
  if (!record) return false;

  await deleteRefreshToken(tokenHash);
  return true;
}

/**
 * Express middleware handler for token refresh endpoint: POST /auth/refresh
 */
function createRefreshHandler(options = {}) {
  return async (req, res, next) => {
    try {
      const rawToken =
        req.body?.refreshToken ||
        req.body?.refresh_token ||
        req.get('x-refresh-token');

      if (!rawToken) {
        return next(new AppError('VALIDATION_ERROR', 'Missing refresh token in request body', 400));
      }

      const result = await refreshTokens(rawToken, options);
      return res.status(200).json(result);
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Express middleware handler for token revocation: POST /auth/revoke
 */
function createRevokeHandler() {
  return async (req, res, next) => {
    try {
      const rawToken =
        req.body?.refreshToken ||
        req.body?.refresh_token ||
        req.get('x-refresh-token');

      if (rawToken) {
        await revokeRefreshToken(rawToken);
      }
      return res.status(200).json({ revoked: true });
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = {
  signJwt,
  createTokenPair,
  refreshTokens,
  revokeRefreshToken,
  revokeFamily,
  hashToken,
  createRefreshHandler,
  createRevokeHandler,
  DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
};
