'use strict';

/**
 * Add composite indexes and query optimizations (#570).
 *
 * Adds composite indexes for common query patterns combining filtering
 * and sorting operations to improve query performance.
 */

exports.up = async function up(knex) {
  // Recipients: list by airdrop with ordering
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_recipients_airdrop_created ON recipients (airdrop_id, created_at DESC)');

  // Alerts: list by asset with status filtering and ordering
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_alerts_asset_status_created ON alerts (asset, status, created_at DESC)');

  // Webhooks: active webhooks by event type (composite for filtering)
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_webhooks_active_event ON webhooks (active, event_type)');

  // API key audit: filter by key and created_at range efficiently
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_api_key_audit_key_created ON api_key_audit_logs (key_id, created_at DESC)');
};

exports.down = async function down(knex) {
  const indexes = [
    'idx_recipients_airdrop_created',
    'idx_alerts_asset_status_created',
    'idx_webhooks_active_event',
    'idx_api_key_audit_key_created',
  ];
  for (const idx of indexes) {
    await knex.raw(`DROP INDEX IF EXISTS ${idx}`);
  }
};
