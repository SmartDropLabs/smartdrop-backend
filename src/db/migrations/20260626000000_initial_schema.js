/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  await knex.raw(`
    -- Airdrop campaigns
    CREATE TABLE airdrops (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      contract_id  TEXT NOT NULL,
      creator      TEXT NOT NULL,
      token        TEXT NOT NULL,
      total_amount BIGINT NOT NULL,
      expiry_ledger BIGINT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'active',
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    );

    -- Individual recipients
    CREATE TABLE recipients (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      airdrop_id  UUID REFERENCES airdrops(id),
      address     TEXT NOT NULL,
      amount      BIGINT NOT NULL,
      claimed_at  TIMESTAMPTZ,
      ledger      BIGINT
    );

    -- Raw contract events
    CREATE TABLE contract_events (
      id          BIGSERIAL PRIMARY KEY,
      ledger      BIGINT NOT NULL,
      tx_hash     TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      payload     JSONB NOT NULL,
      indexed_at  TIMESTAMPTZ DEFAULT NOW()
    );

    -- Indexer cursor
    CREATE TABLE indexer_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS indexer_state;
    DROP TABLE IF EXISTS contract_events;
    DROP TABLE IF EXISTS recipients;
    DROP TABLE IF EXISTS airdrops;
  `);
};
