const knex = require("knex");
const path = require("path");
const fs = require("fs");
const config = require("../config");
const logger = require("../logger");
const {
  MIN_TLS_VERSION,
  buildDatabaseSslConfig,
  buildSecureConnectionConfig,
} = require("./tlsConfig");

let instance = null;

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

function getDb() {
  if (instance) return instance;

  if (!config.database.url) {
    throw new Error("DATABASE_URL is not configured");
  }

  const connection = buildSecureConnectionConfig(config.database, process.env);

  instance = knex({
    client: "pg",
    connection,
    pool: {
      min: config.database.pool.min,
      max: config.database.pool.max,
    },
  });

  return instance;
}

async function ensureTrackingTable(db) {
  const exists = await db.schema.hasTable("schema_migrations");
  if (!exists) {
    await db.schema.createTable("schema_migrations", (table) => {
      table.string("version").primary();
      table.timestamp("applied_at").defaultTo(db.fn.now()).notNullable();
    });
  }
}

function loadMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];

  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((file) => {
      const version = path.basename(file, ".js");
      const migration = require(path.join(MIGRATIONS_DIR, file));
      return { version, ...migration };
    });
}

async function migrateUp() {
  const db = getDb();
  await ensureTrackingTable(db);

  const applied = await db("schema_migrations").select("version");
  const appliedSet = new Set(applied.map((r) => r.version));

  const migrations = loadMigrations();
  const executed = [];

  for (const m of migrations) {
    if (appliedSet.has(m.version)) continue;

    logger.info(`Running migration ${m.version}`);
    await db.transaction(async (trx) => {
      await m.up(trx);
      await trx("schema_migrations").insert({ version: m.version });
    });
    executed.push(m.version);
    logger.info(`Completed migration ${m.version}`);
  }

  return executed;
}

async function migrateDown() {
  const db = getDb();
  await ensureTrackingTable(db);

  const last = await db("schema_migrations")
    .orderBy("version", "desc")
    .first();

  if (!last) {
    logger.info("No migrations to roll back");
    return null;
  }

  const migrations = loadMigrations();
  const target = migrations.find((m) => m.version === last.version);

  if (!target) {
    throw new Error(`Migration file not found for version ${last.version}`);
  }

  logger.info(`Rolling back migration ${target.version}`);
  await db.transaction(async (trx) => {
    await target.down(trx);
    await trx("schema_migrations").where({ version: target.version }).del();
  });
  logger.info(`Rolled back migration ${target.version}`);

  return target.version;
}

async function getMigrationStatus() {
  const db = getDb();
  await ensureTrackingTable(db);

  const applied = await db("schema_migrations").orderBy("version", "asc");
  const appliedMap = new Map(applied.map((r) => [r.version, r.applied_at]));

  const migrations = loadMigrations();
  return migrations.map((m) => ({
    version: m.version,
    status: appliedMap.has(m.version) ? "applied" : "pending",
    applied_at: appliedMap.get(m.version) || null,
  }));
}

async function closeDb() {
  if (instance) {
    await instance.destroy();
    instance = null;
  }
}

function setDb(customInstance) {
  instance = customInstance;
}

module.exports = {
  getDb,
  closeDb,
  setDb,
  migrateUp,
  migrateDown,
  getMigrationStatus,
  loadMigrations,
  MIN_TLS_VERSION,
  buildDatabaseSslConfig,
  buildSecureConnectionConfig,
};