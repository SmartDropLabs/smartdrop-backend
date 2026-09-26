const cors = require('cors');
const config = require('../config');
const AppError = require('../errors/AppError');

function buildCorsMiddleware(allowedOrigins) {
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
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    // Issue #344: preflight (OPTIONS) responses carry Access-Control-Max-Age
    // so browsers can cache the result instead of re-sending a preflight for
    // every cross-origin POST. Window defaults to 24h and is tunable via
    // CORS_MAX_AGE_SECONDS.
    maxAge: config.corsMaxAgeSeconds,
  });
}

module.exports = buildCorsMiddleware;
