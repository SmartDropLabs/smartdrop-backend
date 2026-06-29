const apiKeys = require('../services/apiKeys');
const logger = require('../logger');
const AppError = require('../errors/AppError');

function extractBearerToken(header) {
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function hasScopes(apiKey, requiredScopes) {
  if (!requiredScopes.length) return true;
  const scopes = new Set(apiKey.scopes || []);
  return requiredScopes.every((scope) => scopes.has(scope));
}

function requireApiKey(options = {}) {
  const requiredScopes = options.scopes || [];

  return async (req, res, next) => {
    const token = extractBearerToken(req.get('authorization'));
    if (!token) {
      return next(new AppError('UNAUTHORIZED', 'Missing or invalid API key', 401));
    }

    try {
      const apiKey = await apiKeys.validateApiKey(token);
      if (!apiKey || !hasScopes(apiKey, requiredScopes)) {
        logger.warn('Rejected API key authentication', { key_prefix: token.slice(0, 8) });
        return next(new AppError('UNAUTHORIZED', 'Missing or invalid API key', 401));
      }

      req.apiKey = apiKey;
      return next();
    } catch (err) {
      logger.error('API key authentication failed', { error: err.message });
      return next(new AppError('UNAUTHORIZED', 'Missing or invalid API key', 401));
    }
  };
}

module.exports = {
  requireApiKey,
  extractBearerToken,
};
