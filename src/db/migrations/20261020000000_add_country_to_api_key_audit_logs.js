/**
 * Migration: add country to API key audit logs (#697)
 *
 * Stores the ISO 3166-1 alpha-2 country resolved from the client IP. The column
 * is nullable: rows written before geolocation was enabled, or while no lookup
 * is configured, have no country.
 */

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE api_key_audit_logs ADD COLUMN IF NOT EXISTS country CHAR(2);
  `);
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.raw(`
    ALTER TABLE api_key_audit_logs DROP COLUMN IF EXISTS country;
  `);
};
