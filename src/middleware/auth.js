const apiKeys = require("../services/apiKeys");
const apiKeyAuditLog = require("../services/apiKeyAuditLog");
const logger = require("../logger");
const AppError = require("../errors/AppError");

function extractBearerToken(header) {
  if (!header || typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function extractClientIp(req) {
  // Check for IP from various headers (proxy, load balancer, etc.)
  return (
    req.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.get("x-client-ip") ||
    req.socket?.remoteAddress ||
    req.ip ||
    "unknown"
  );
}

function hasScopes(apiKey, requiredScopes) {
  if (!requiredScopes || !requiredScopes.length) return true;
  const scopes = new Set(apiKey.scopes || []);
  if (scopes.has("admin")) return true;
  return requiredScopes.every((scope) => scopes.has(scope));
}

function requireApiKey(options = {}) {
  const requiredScopes = Array.isArray(options)
    ? options
    : typeof options === "string"
      ? [options]
      : options.scopes || [];

  return async (req, res, next) => {
    const token = extractBearerToken(req.get("authorization"));
    if (!token) {
      return next(
        new AppError("UNAUTHORIZED", "Missing or invalid API key", 401),
      );
    }

    try {
      const apiKey = req.apiKey || (await apiKeys.validateApiKey(token));
      if (!apiKey) {
        logger.warn("Rejected API key authentication", {
          key_prefix: token.slice(0, 8),
        });
        return next(
          new AppError("UNAUTHORIZED", "Missing or invalid API key", 401),
        );
      }

      if (!hasScopes(apiKey, requiredScopes)) {
        logger.warn("Rejected API key due to insufficient scopes", {
          key_prefix: token.slice(0, 8),
          requiredScopes,
          actualScopes: apiKey.scopes,
        });
        return next(
          new AppError("FORBIDDEN", "Insufficient API key scope", 403),
        );
      }

      req.apiKey = apiKey;
      return next();
    } catch (err) {
      logger.error("API key authentication failed", { error: err.message });
      return next(
        new AppError("UNAUTHORIZED", "Missing or invalid API key", 401),
      );
    }
  };
}

/**
 * Resolves an API key onto `req.apiKey` when one is present, without
 * rejecting requests that omit or fail authentication (issue #251).
 *
 * Authentication itself stays with `requireApiKey` on the routes that need
 * it. This middleware exists only so the per-key rate limiter can meter a
 * key from the very first middleware layer — including on routes where
 * authentication happens further down the stack — instead of validating the
 * key a second time itself.
 *
 * An invalid key resolves to no key at all, so it falls through to the
 * IP-keyed limiter and is then rejected by `requireApiKey` as before.
 */
function attachApiKey() {
  return async (req, res, next) => {
    if (req.apiKey) return next();

    const token = extractBearerToken(req.get("authorization"));
    if (!token) return next();

    try {
      const apiKey = await apiKeys.validateApiKey(token);
      if (apiKey) req.apiKey = apiKey;
    } catch (err) {
      // Never fail the request here — `requireApiKey` owns rejection.
      logger.warn("Optional API key resolution failed", { error: err.message });
    }
    return next();
  };
}

/**
 * Logs API key usage for audit trail after response is sent.
 * Captures: endpoint, IP address, status code, response time
 */
function auditApiKeyUsage() {
  return async (req, res, next) => {
    const startTime = Date.now();

    // Capture response finish to log after request completes
    res.on("finish", () => {
      if (!req.apiKey) return; // No API key used, skip logging

      const endpoint = `${req.method} ${req.path}`;
      const ipAddress = extractClientIp(req);
      const statusCode = res.statusCode;
      const responseTimeMs = Date.now() - startTime;

      // Log asynchronously, don't wait for it
      apiKeyAuditLog.logUsage({
        keyId: req.apiKey.id,
        endpoint,
        ipAddress,
        statusCode,
        responseTimeMs,
      });
    });

    return next();
  };
}

module.exports = {
  requireApiKey,
  attachApiKey,
  auditApiKeyUsage,
  extractBearerToken,
};
