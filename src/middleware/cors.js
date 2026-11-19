const cors = require('cors');
const config = require('../config');
const logger = require('../logger');
const AppError = require('../errors/AppError');

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/**
 * Production guard for the CORS allowlist (#621).
 *
 * config.corsAllowedOrigins falls back to the localhost dev origins when
 * CORS_ALLOWED_ORIGINS is unset, so a production deploy that forgot the
 * variable would silently keep accepting the dev origins. In production:
 * an unset CORS_ALLOWED_ORIGINS allows no cross-origin callers (fail
 * closed, logged loudly), and localhost origins are dropped even if listed.
 * A wildcard is never honoured — with `credentials: true` it would let any
 * site make credentialed requests.
 */
function resolveAllowedOrigins(
  origins,
  { nodeEnv = process.env.NODE_ENV, explicit = process.env.CORS_ALLOWED_ORIGINS } = {},
) {
  const list = (origins || []).filter((origin) => origin !== '*');
  if (nodeEnv !== 'production') return list;

  if (!explicit || !explicit.trim()) {
    logger.error(
      'CORS_ALLOWED_ORIGINS is not set in production; refusing all cross-origin requests',
    );
    return [];
  }
  const dropped = list.filter((origin) => LOCAL_ORIGIN.test(origin));
  if (dropped.length) {
    logger.warn('Ignoring localhost CORS origins in production', { origins: dropped });
  }
  return list.filter((origin) => !LOCAL_ORIGIN.test(origin));
}

function buildCorsMiddleware(configuredOrigins, options) {
  const allowedOrigins = resolveAllowedOrigins(configuredOrigins, options);
  return cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(new AppError(
        'FORBIDDEN',
        `Origin '${origin}' is not allowed. Allowed origins: ${allowedOrigins.join(', ')}`,
        403,
        { origin, allowed_origins: allowedOrigins },
      ));
    },
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-CSRF-Token'],
    // Issue #344: preflight (OPTIONS) responses carry Access-Control-Max-Age
    // so browsers can cache the result instead of re-sending a preflight for
    // every cross-origin POST. Window defaults to 24h and is tunable via
    // CORS_MAX_AGE_SECONDS.
    maxAge: config.corsMaxAgeSeconds,
  });
}

module.exports = buildCorsMiddleware;
module.exports.resolveAllowedOrigins = resolveAllowedOrigins;
