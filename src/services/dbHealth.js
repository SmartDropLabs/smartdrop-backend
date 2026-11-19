"use strict";

const knexFactory = require("knex");
const config = require("../config");

let db = null;

async function checkPoolHealth() {
  if (!db || !db.client || !db.client.pool) {
    return { total: 0, idle: 0, waiting: 0 };
  }
  const pool = db.client.pool;
  return {
    total: typeof pool.numUsed === 'function' ? pool.numUsed() + pool.numFree() : (pool.totalCount || 0),
    idle: typeof pool.numFree === 'function' ? pool.numFree() : (pool.idleCount || 0),
    waiting: typeof pool.numPendingAcquires === 'function' ? pool.numPendingAcquires() : (pool.waitingCount || 0),
  };
}

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
    const pool = await checkPoolHealth();
    return { configured: true, checked: true, status: "ok", pool };
  } catch (_err) {
    return { configured: true, checked: true, status: "error" };
  }
}

module.exports = { checkDatabase, checkPoolHealth };
