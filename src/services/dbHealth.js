"use strict";

const knexFactory = require("knex");
const config = require("../config");

let db = null;

async function checkDatabase() {
  if (!config.databaseUrl) {
    return { configured: false, checked: false, status: "unavailable" };
  }

  try {
    if (!db) {
      db = knexFactory({
        client: "pg",
        connection: {
          connectionString: config.databaseUrl,
          connectionTimeoutMillis: 1000,
          query_timeout: 1000,
        },
        acquireConnectionTimeout: 1000,
        pool: { min: 0, max: 1 },
      });
    }

    await db.raw("SELECT 1");
    return { configured: true, checked: true, status: "ok" };
  } catch (_err) {
    return { configured: true, checked: true, status: "error" };
  }
}

module.exports = { checkDatabase };
