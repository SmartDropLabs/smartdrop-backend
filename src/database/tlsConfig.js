"use strict";

const MIN_TLS_VERSION = "TLSv1.2";

function isLoopbackHost(hostname) {
  if (!hostname) return false;
  const normalized = String(hostname).toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function parseSslMode(connectionString) {
  if (!connectionString || typeof connectionString !== "string") return null;
  try {
    const url = new URL(connectionString);
    const mode = url.searchParams.get("sslmode");
    return mode ? mode.toLowerCase() : null;
  } catch {
    return null;
  }
}

function parseHost(connectionString) {
  if (!connectionString || typeof connectionString !== "string") return null;
  try {
    const url = new URL(connectionString);
    return url.hostname || null;
  } catch {
    return null;
  }
}

function buildDatabaseSslConfig(databaseConfig = {}, env = process.env) {
  const connectionString = databaseConfig.url || env.DATABASE_URL || "";
  const sslMode = parseSslMode(connectionString);
  const hostname = parseHost(connectionString);
  const nodeEnv = (env.NODE_ENV || "").toLowerCase();
  const rawDbSsl = env.DB_SSL !== undefined ? String(env.DB_SSL).toLowerCase() : undefined;

  if (rawDbSsl === "false" || rawDbSsl === "0" || sslMode === "disable") {
    if (nodeEnv === "production" && !isLoopbackHost(hostname)) {
      throw new Error(
        "Database TLS encryption in transit cannot be disabled for non-loopback hosts in production"
      );
    }
    return false;
  }

  const shouldEnableTls =
    rawDbSsl === "true" ||
    rawDbSsl === "1" ||
    Boolean(sslMode && sslMode !== "disable") ||
    (nodeEnv === "production" && !isLoopbackHost(hostname)) ||
    Boolean(databaseConfig.ssl);

  if (!shouldEnableTls) {
    return false;
  }

  const rejectUnauthorized =
    env.DB_SSL_REJECT_UNAUTHORIZED !== undefined
      ? !["false", "0"].includes(String(env.DB_SSL_REJECT_UNAUTHORIZED).toLowerCase())
      : sslMode !== "allow" && sslMode !== "prefer";

  const sslOptions = {
    rejectUnauthorized,
    minVersion: MIN_TLS_VERSION,
  };

  if (env.DB_SSL_CA || databaseConfig.sslCa) {
    sslOptions.ca = databaseConfig.sslCa || env.DB_SSL_CA;
  }
  if (env.DB_SSL_CERT || databaseConfig.sslCert) {
    sslOptions.cert = databaseConfig.sslCert || env.DB_SSL_CERT;
  }
  if (env.DB_SSL_KEY || databaseConfig.sslKey) {
    sslOptions.key = databaseConfig.sslKey || env.DB_SSL_KEY;
  }

  return sslOptions;
}

function buildSecureConnectionConfig(databaseConfig = {}, env = process.env) {
  const connectionString = databaseConfig.url || env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured");
  }

  const ssl = buildDatabaseSslConfig(databaseConfig, env);
  if (!ssl) {
    return connectionString;
  }

  return {
    connectionString,
    ssl,
  };
}

module.exports = {
  MIN_TLS_VERSION,
  isLoopbackHost,
  parseSslMode,
  buildDatabaseSslConfig,
  buildSecureConnectionConfig,
};