/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  await knex.raw(`
    -- Airdrop CRUD records (distinct from the indexer airdrops table which
    -- mirrors on-chain contract state). This table backs the Redis-backed
    -- airdrops service that manages draft/active/completed lifecycle.
    CREATE TABLE service_airdrops (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      description   TEXT,
      asset         TEXT NOT NULL,
      asset_issuer  TEXT NOT NULL,
      total_amount  BIGINT NOT NULL,
      expiry_ledger BIGINT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'draft',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE service_airdrop_recipients (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      airdrop_id   TEXT NOT NULL REFERENCES service_airdrops(id) ON DELETE CASCADE,
      address      TEXT NOT NULL,
      amount       BIGINT NOT NULL,
      claimed_at   TIMESTAMPTZ,
      ledger       BIGINT,
      UNIQUE (airdrop_id, address)
    );

    CREATE INDEX idx_service_airdrop_recipients_airdrop
      ON service_airdrop_recipients (airdrop_id);
  `);
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS service_airdrop_recipients;
    DROP TABLE IF EXISTS service_airdrops;
  `);
};
