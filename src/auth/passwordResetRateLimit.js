'use strict';

const { buildRateLimit } = require('../middleware/rateLimit');

// 5 password reset attempts per 15 minutes per IP (#558).
// Prevents email bombing and user enumeration via timing.
const passwordResetRateLimit = buildRateLimit({
  windowSeconds: 900,
  max: 5,
  keyPrefix: 'pwd_reset',
});

module.exports = { passwordResetRateLimit };
