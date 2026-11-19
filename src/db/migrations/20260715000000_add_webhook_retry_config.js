/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  await knex.raw(`
    ALTER TABLE webhooks
      ADD COLUMN IF NOT EXISTS retry_base_ms INT,
      ADD COLUMN IF NOT EXISTS retry_factor DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS max_attempts INT;
  `);
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  await knex.raw(`
    ALTER TABLE webhooks
      DROP COLUMN IF EXISTS retry_base_ms,
      DROP COLUMN IF EXISTS retry_factor,
      DROP COLUMN IF EXISTS max_attempts;
  `);
};
