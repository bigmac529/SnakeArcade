"use strict";
// Versioned SQL migrations: migrations/<dialect>/NNN_name.sql, applied in
// order, each in its own transaction, recorded in schema_migrations. Run at
// startup (DB_MIGRATE_ON_START=true, the default) or with `npm run migrate`.
const fs = require("fs");
const path = require("path");

const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "migrations");

const CREATE_TABLE = {
  sqlite: "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER NOT NULL PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
  mssql:
    "IF OBJECT_ID(N'dbo.schema_migrations', N'U') IS NULL CREATE TABLE dbo.schema_migrations (version INT NOT NULL CONSTRAINT pk_schema_migrations PRIMARY KEY, name NVARCHAR(200) NOT NULL, applied_at BIGINT NOT NULL)"
};

function listMigrations(dialect, dir = MIGRATIONS_DIR) {
  const folder = path.join(dir, dialect);
  return fs
    .readdirSync(folder)
    .filter((f) => /^\d+_[\w-]+\.sql$/.test(f))
    .sort()
    .map((file) => ({ version: Number(file.split("_")[0]), name: file, path: path.join(folder, file) }));
}

async function appliedVersions(db) {
  await db.exec(CREATE_TABLE[db.dialect]);
  const rows = await db.all("SELECT version FROM schema_migrations");
  return new Set(rows.map((r) => Number(r.version)));
}

async function pendingMigrations(db, dir) {
  const applied = await appliedVersions(db);
  return listMigrations(db.dialect, dir).filter((m) => !applied.has(m.version));
}

async function migrate(db, { dir, log = () => {} } = {}) {
  const pending = await pendingMigrations(db, dir);
  for (const m of pending) {
    const script = fs.readFileSync(m.path, "utf8");
    await db.transaction(async (tx) => {
      await tx.exec(script);
      await tx.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (@version, @name, @at)", {
        version: m.version,
        name: m.name,
        at: Date.now()
      });
    });
    log(`Applied migration ${m.name}`);
  }
  const all = listMigrations(db.dialect, dir);
  return { applied: pending.map((m) => m.name), version: all.length ? all[all.length - 1].version : 0 };
}

module.exports = { migrate, pendingMigrations, listMigrations };
