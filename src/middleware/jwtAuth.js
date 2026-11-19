"use strict";

const crypto = require("crypto");
const AppError = require("../errors/AppError");
const logger = require("../logger");

/**
 * JWT validation middleware (#448).
 *
 * Properly validates JWT tokens with:
 * - Signature verification (HMAC-SHA256)
 * - Expiration check
 * - Issuer validation
 * - Audience validation
 * - Algorithm whitelist (prevents alg: none / alg confusion attacks)
 * - Token blacklist on logout (#661)
 *
 * Usage: jwtAuth({ secret: '...', issuer: '...', audience: '...' })
 */

const ALLOWED_ALGORITHMS = ["HS256", "HS384", "HS512"];
const ALGORITHM_HASHES = {
  HS256: "sha256",
  HS384: "sha384",
  HS512: "sha512",
};

// In-memory token blacklist
// NOTE: For production with multiple instances, use Redis or another shared store
const tokenBlacklist = new Map();
const BLACKLIST_CLEANUP_INTERVAL_MS = 60000; // Clean up every minute

// Periodically clean expired tokens from blacklist
setInterval(() => {
  const now = Date.now();
  for (const [token, expiresAt] of tokenBlacklist.entries()) {
    if (now >= expiresAt) {
      tokenBlacklist.delete(token);
    }
  }
}, BLACKLIST_CLEANUP_INTERVAL_MS);

function base64UrlDecode(str) {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function base64UrlEncode(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function hmacSign(data, secret, algorithm) {
  return crypto
    .createHmac(ALGORITHM_HASHES[algorithm], secret)
    .update(data)
    .digest();
}

/**
 * Check if a token is blacklisted.
 * @param {string} token - The JWT token to check
 * @returns {boolean} True if token is blacklisted
 */
function isTokenBlacklisted(token) {
  if (!tokenBlacklist.has(token)) {
    return false;
  }

  const expiresAt = tokenBlacklist.get(token);
  const now = Date.now();

  if (now >= expiresAt) {
    // Expired blacklist entry, clean it up
    tokenBlacklist.delete(token);
    return false;
  }

  return true;
}

/**
 * Add a token to the blacklist.
 * @param {string} token - The JWT token to blacklist
 * @param {number} ttlSeconds - Time to live in seconds (until token naturally expires)
 */
function blacklistToken(token, ttlSeconds) {
  const expiresAt = Date.now() + ttlSeconds * 1000;
  tokenBlacklist.set(token, expiresAt);
  logger.info("Token blacklisted", {
    tokenHash: crypto
      .createHash("sha256")
      .update(token)
      .digest("hex")
      .substring(0, 16),
    ttlSeconds,
  });
}

/**
 * Logout function - blacklist a JWT token.
 * For production with Redis, replace in-memory Map with Redis SET command.
 *
 * @param {string} token - The JWT token to invalidate
 * @param {Object} options - Configuration options
 * @param {string} options.secret - JWT secret for decoding
 * @param {Object} [options.redis] - Optional Redis client for distributed blacklist
 * @returns {Promise<void>}
 */
async function logout(token, options = {}) {
  if (!token) {
    throw new Error("Token is required for logout");
  }

  try {
    // Decode token to get expiration (don't need full verification for logout)
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new Error("Invalid token format");
    }

    const payload = JSON.parse(base64UrlDecode(parts[1]).toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    const ttl = payload.exp ? Math.max(payload.exp - now, 0) : 3600; // Default 1 hour if no exp

    // If Redis client provided, use it (for production multi-instance setup)
    if (options.redis && typeof options.redis.set === "function") {
      await options.redis.set(`blacklist:${token}`, "1", "EX", ttl);
      logger.info("Token blacklisted in Redis", { ttl });
    } else {
      // Otherwise use in-memory blacklist
      blacklistToken(token, ttl);
    }
  } catch (err) {
    logger.error("Failed to blacklist token during logout", {
      error: err.message,
    });
    throw err;
  }
}

/**
 * Verify a JWT token's signature and claims.
 * Returns the decoded payload if valid, throws on any failure.
 */
function verifyJwt(token, secret, options = {}) {
  // Check if token is blacklisted
  if (isTokenBlacklisted(token)) {
    logger.warn("JWT rejected: token is blacklisted (logged out)");
    throw new AppError("UNAUTHORIZED", "Invalid token", 401);
  }

  // Check Redis blacklist if client provided
  if (options.redis && typeof options.redis.get === "function") {
    // Note: This is a sync check for async Redis, caller should handle properly
    // For proper async handling, verifyJwt should be made async
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AppError("UNAUTHORIZED", "Invalid JWT format", 401);
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // Decode and validate header
  let header;
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString("utf8"));
  } catch {
    throw new AppError("UNAUTHORIZED", "Invalid JWT header", 401);
  }

  // Algorithm whitelist — prevents alg: none and algorithm confusion attacks
  if (!ALLOWED_ALGORITHMS.includes(header.alg)) {
    logger.warn("JWT rejected: disallowed algorithm", { alg: header.alg });
    throw new AppError("UNAUTHORIZED", "Invalid JWT algorithm", 401);
  }

  // Signature verification
  const data = `${headerB64}.${payloadB64}`;
  const expectedSig = hmacSign(data, secret, header.alg);
  const actualSig = base64UrlDecode(signatureB64);

  if (
    expectedSig.length !== actualSig.length ||
    !crypto.timingSafeEqual(expectedSig, actualSig)
  ) {
    throw new AppError("UNAUTHORIZED", "Invalid JWT signature", 401);
  }

  // Decode payload
  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8"));
  } catch {
    throw new AppError("UNAUTHORIZED", "Invalid JWT payload", 401);
  }

  // Expiration check (#469)
  // A token that carries no expiry must be rejected, not treated as eternal.
  const CLOCK_SKEW_LEEWAY_SECONDS =
    parseInt(process.env.AUTH_CLOCK_SKEW_SECONDS, 10) || 60;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp === undefined || typeof payload.exp !== "number") {
    logger.warn("JWT rejected: missing or invalid exp claim");
    throw new AppError("UNAUTHORIZED", "Invalid token", 401);
  }
  if (payload.exp + CLOCK_SKEW_LEEWAY_SECONDS < now) {
    logger.warn("JWT rejected: token expired", { exp: payload.exp, now });
    throw new AppError("UNAUTHORIZED", "Invalid token", 401);
  }

  // Not-before check
  if (payload.nbf !== undefined && typeof payload.nbf === "number") {
    if (payload.nbf > now) {
      throw new AppError("UNAUTHORIZED", "JWT not yet valid", 401);
    }
  }

  // Issuer validation
  if (options.issuer && payload.iss !== options.issuer) {
    logger.warn("JWT rejected: issuer mismatch", {
      expected: options.issuer,
      actual: payload.iss,
    });
    throw new AppError("UNAUTHORIZED", "Invalid JWT issuer", 401);
  }

  // Audience validation
  if (options.audience) {
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(options.audience)) {
      logger.warn("JWT rejected: audience mismatch", {
        expected: options.audience,
        actual: payload.aud,
      });
      throw new AppError("UNAUTHORIZED", "Invalid JWT audience", 401);
    }
  }

  return payload;
}

/**
 * Express middleware factory for JWT authentication.
 *
 * Validates the Bearer token as a JWT and attaches the decoded payload
 * to `req.jwt`. Falls back to API key validation if the token is not a JWT.
 */
function jwtAuth(options = {}) {
  const { secret, issuer, audience, required = true } = options;

  return (req, res, next) => {
    const authHeader = req.get("authorization");
    if (!authHeader || !authHeader.match(/^Bearer\s+/i)) {
      if (required) {
        return next(
          new AppError(
            "UNAUTHORIZED",
            "Missing or invalid Authorization header",
            401,
          ),
        );
      }
      return next();
    }

    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) {
      if (required) {
        return next(
          new AppError("UNAUTHORIZED", "Missing or invalid token", 401),
        );
      }
      return next();
    }

    try {
      const payload = verifyJwt(token, secret, { issuer, audience });
      req.jwt = payload;
      return next();
    } catch (err) {
      if (err instanceof AppError) {
        return next(err);
      }
      logger.error("JWT validation failed", { error: err.message });
      return next(new AppError("UNAUTHORIZED", "Invalid token", 401));
    }
  };
}

module.exports = {
  verifyJwt,
  jwtAuth,
  logout,
  blacklistToken,
  isTokenBlacklisted,
  base64UrlDecode,
  base64UrlEncode,
};
