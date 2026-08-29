const cors = require('cors');
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
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  });
}

module.exports = buildCorsMiddleware;
