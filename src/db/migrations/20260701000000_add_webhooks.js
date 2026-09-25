/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  await knex.raw(`
    CREATE TABLE webhooks (
      id           TEXT PRIMARY KEY,
      url          TEXT NOT NULL,
      events       TEXT[] NOT NULL,
      secret       TEXT NOT NULL,
      active       BOOLEAN NOT NULL DEFAULT true,
      description  TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE webhook_deliveries (
      id               TEXT PRIMARY KEY,
      webhook_id       TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
      event_id         TEXT NOT NULL,
      event_type       TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'pending',
      attempts         INT NOT NULL DEFAULT 0,
      last_error       TEXT,
      last_attempt_at  TIMESTAMPTZ,
      next_retry_at    TIMESTAMPTZ,
      response_status  INT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_webhook_deliveries_webhook_created
      ON webhook_deliveries (webhook_id, created_at DESC);

    CREATE INDEX idx_webhook_deliveries_next_retry
      ON webhook_deliveries (next_retry_at)
      WHERE next_retry_at IS NOT NULL;
  `);
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS webhook_deliveries;
    DROP TABLE IF EXISTS webhooks;
  `);
};
