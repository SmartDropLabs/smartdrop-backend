/**
 * Migration: Add API Key Audit Logs
 * 
 * Creates table to track API key usage: which endpoint was accessed, when, and from which IP.
 * This is essential for security auditing and detecting misuse.
 */

exports.up = async (knex) => {
  await knex.schema.createTable('api_key_audit_logs', (table) => {
    table.increments('id').primary();
    table.string('key_id').notNullable().index();
    table.string('endpoint').notNullable(); // e.g. GET /api/prices
    table.string('ip_address').notNullable();
    table.integer('status_code'); // HTTP response status
    table.integer('response_time_ms'); // Request duration in milliseconds
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    
    // Composite index for common queries: key_id + created_at
    table.index(['key_id', 'created_at']);
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTable('api_key_audit_logs');
};
