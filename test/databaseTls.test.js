const {
  MIN_TLS_VERSION,
  buildDatabaseSslConfig,
  buildSecureConnectionConfig,
} = require("../src/database");

describe("Database TLS encryption in transit (#529)", () => {
  test("enforces TLSv1.2+ with certificate verification in production on remote hosts", () => {
    const ssl = buildDatabaseSslConfig(
      { url: "postgres://user:pass@db.internal.example.com:5432/smartdrop" },
      { NODE_ENV: "production" }
    );
    expect(ssl).toEqual({
      rejectUnauthorized: true,
      minVersion: MIN_TLS_VERSION,
    });
  });

  test("rejects disabling TLS in production for remote database hosts", () => {
    expect(() =>
      buildDatabaseSslConfig(
        { url: "postgres://user:pass@db.internal.example.com:5432/smartdrop" },
        { NODE_ENV: "production", DB_SSL: "false" }
      )
    ).toThrow(/cannot be disabled/);
  });

  test("supports custom CA, client certificate, and key via environment variables", () => {
    const conn = buildSecureConnectionConfig(
      { url: "postgres://user:pass@db.example.com:5432/smartdrop?sslmode=verify-full" },
      {
        DB_SSL: "true",
        DB_SSL_CA: "-----BEGIN CERTIFICATE-----CA",
        DB_SSL_CERT: "-----BEGIN CERTIFICATE-----CERT",
        DB_SSL_KEY: "-----BEGIN PRIVATE KEY-----KEY",
      }
    );
    expect(conn).toEqual({
      connectionString: "postgres://user:pass@db.example.com:5432/smartdrop?sslmode=verify-full",
      ssl: {
        rejectUnauthorized: true,
        minVersion: MIN_TLS_VERSION,
        ca: "-----BEGIN CERTIFICATE-----CA",
        cert: "-----BEGIN CERTIFICATE-----CERT",
        key: "-----BEGIN PRIVATE KEY-----KEY",
      },
    });
  });

  test("leaves local development connections plain when TLS is not requested", () => {
    const conn = buildSecureConnectionConfig(
      { url: "postgres://localhost:5432/smartdrop_dev" },
      { NODE_ENV: "development" }
    );
    expect(conn).toBe("postgres://localhost:5432/smartdrop_dev");
  });
});