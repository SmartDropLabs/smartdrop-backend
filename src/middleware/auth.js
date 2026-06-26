const apiKeys = require('../services/apiKeys');
const logger = require('../logger');

const UNAUTHORIZED = { error: 'Missing or invalid API key' };

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
      return res.status(401).json(UNAUTHORIZED);
    }

    try {
      const apiKey = await apiKeys.validateApiKey(token);
      if (!apiKey || !hasScopes(apiKey, requiredScopes)) {
        logger.warn('Rejected API key authentication', { key_prefix: token.slice(0, 8) });
        return res.status(401).json(UNAUTHORIZED);
      }

      req.apiKey = apiKey;
      return next();
    } catch (err) {
      logger.error('API key authentication failed', { error: err.message });
      return res.status(401).json(UNAUTHORIZED);
    }
  };
}

module.exports = {
  requireApiKey,
  extractBearerToken,
};
