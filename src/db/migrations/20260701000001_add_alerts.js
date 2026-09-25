/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  await knex.raw(`
    CREATE TABLE alerts (
      id              TEXT PRIMARY KEY,
      asset           TEXT NOT NULL,
      type            TEXT NOT NULL,
      threshold_usd   NUMERIC NOT NULL,
      webhook_url     TEXT NOT NULL,
      webhook_secret  TEXT NOT NULL,
      repeat          BOOLEAN NOT NULL DEFAULT false,
      baseline_price  NUMERIC,
      last_fired_at   TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_alerts_asset ON alerts (asset);
  `);
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS alerts;
  `);
};
