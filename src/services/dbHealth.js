'use strict';

/**
 * Lightweight database configuration check.
 *
 * The database (added for api_key_audit_logs, see migrations) is not yet on
 * any live request path — nothing in the app queries it at runtime. So
 * `/health` only reports whether a connection string is *configured*
 * (via the same resolved config the migration CLI uses, including its
 * dev/test defaults) rather than actually opening a connection: attempting
 * a real ping here would make `/health` depend on a dependency the app
 * doesn't actually use yet, and could flap the endpoint on a DB blip that
 * doesn't affect anything real.
 */

const config = require('../config');

function checkDatabase() {
  if (!config.databaseUrl) {
    return { configured: false, checked: false, status: 'unavailable' };
  }
  return { configured: true, checked: false, status: 'unused' };
}

module.exports = { checkDatabase };
