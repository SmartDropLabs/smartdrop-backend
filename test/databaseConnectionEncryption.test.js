'use strict';

const config = require('../src/config');
const encryption = require('../src/database/encryption');
const database = require('../src/database');

describe('encrypted database connection URL', () => {
  const originalConfig = {
    databaseUrl: config.databaseUrl,
    databaseUrlEncrypted: config.databaseUrlEncrypted,
    databaseEncryptionKey: config.databaseEncryptionKey,
    dbEncryptionKey: config.dbEncryptionKey,
  };

  afterEach(async () => {
    await database.closeDb();
    Object.assign(config, originalConfig);
    encryption._resetCachedKey();
  });

  test('decrypts DATABASE_URL_ENCRYPTED when initializing the connection pool', () => {
    const key = 'test-database-encryption-key';
    const expectedUrl = 'postgres://dbuser:dbpassword@db.example:5432/smartdrop';
    config.databaseEncryptionKey = key;
    config.dbEncryptionKey = key;
    encryption._resetCachedKey();
    config.databaseUrl = 'postgres://ignored/legacy';
    config.databaseUrlEncrypted = encryption.encrypt(expectedUrl);

    const db = database.getDb();

    expect(db.client.config.connection).toMatchObject({
      database: 'smartdrop',
      host: 'db.example',
      password: 'dbpassword',
      user: 'dbuser',
    });
  });
});
