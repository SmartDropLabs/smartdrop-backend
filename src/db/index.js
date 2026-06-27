const knex = require('knex');
const knexfile = require('./knexfile');

/**
 * @type {import('knex').Knex}
 */
const db = knex(knexfile);

module.exports = {
  db,
  
  /** Query helper for airdrops table */
  airdrops: () => db('airdrops'),
  
  /** Query helper for recipients table */
  recipients: () => db('recipients'),
  
  /** Query helper for contract_events table */
  contractEvents: () => db('contract_events'),
  
  /** Query helper for indexer_state table */
  indexerState: () => db('indexer_state')
};
