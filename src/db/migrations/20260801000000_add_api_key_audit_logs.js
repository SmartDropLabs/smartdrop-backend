/**
 * Migration: Add API Key Audit Logs
 *
 * Creates table to track API key usage: which endpoint was accessed, when, and from which IP.
 * This is essential for security auditing and detecting misuse.
 */

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE api_key_audit_logs (
      id                SERIAL PRIMARY KEY,
      key_id            TEXT NOT NULL,
      endpoint          TEXT NOT NULL,
      ip_address        TEXT NOT NULL,
      status_code       INTEGER,
      response_time_ms  INTEGER,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_api_key_audit_logs_key_id ON api_key_audit_logs (key_id);
    CREATE INDEX idx_api_key_audit_logs_key_id_created_at ON api_key_audit_logs (key_id, created_at);
  `);
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS api_key_audit_logs;
  `);
};
