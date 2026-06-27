const config = require('../config');

module.exports = {
  client: 'pg',
  connection: config.databaseUrl,
  pool: {
    min: 2,
    max: 10
  },
  migrations: {
    directory: './migrations',
    tableName: 'knex_migrations'
  }
};
