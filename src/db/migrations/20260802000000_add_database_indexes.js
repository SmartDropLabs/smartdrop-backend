'use strict';

/**
 * Add database indexes for common query patterns (#501).
 *
 * These indexes cover the most frequent lookup paths identified from
 * repository query patterns: foreign keys, status filters, and
 * timestamp-based range queries.
 */

exports.up = async function up(knex) {
  // airdrops: status + expiry lookups, creator lookups
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_airdrops_status ON airdrops (status)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_airdrops_creator ON airdrops (creator)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_airdrops_expiry ON airdrops (expiry_ledger)');

  // recipients: airdrop lookups, address lookups
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_recipients_airdrop ON recipients (airdrop_id)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_recipients_address ON recipients (address)');

  // webhooks: active/event lookups
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks (active)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_webhooks_event ON webhooks (event_type)');

  // alerts: status + created_at range queries
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts (status)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts (created_at)');

  // api_key_audit_logs: key_id + created_at range queries
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_api_key_audit_key ON api_key_audit_logs (key_id)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_api_key_audit_created ON api_key_audit_logs (created_at)');

  // auth_challenges: wallet lookups (already unique, but ensure exists)
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_auth_challenges_wallet ON auth_challenges (wallet_address)');
};

exports.down = async function down(knex) {
  const indexes = [
    'idx_airdrops_status', 'idx_airdrops_creator', 'idx_airdrops_expiry',
    'idx_recipients_airdrop', 'idx_recipients_address',
    'idx_webhooks_active', 'idx_webhooks_event',
    'idx_alerts_status', 'idx_alerts_created',
    'idx_api_key_audit_key', 'idx_api_key_audit_created',
    'idx_auth_challenges_wallet',
  ];
  for (const idx of indexes) {
    await knex.raw(`DROP INDEX IF EXISTS ${idx}`);
  }
};
