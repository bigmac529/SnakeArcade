"use strict";
// npm run migrate            apply pending migrations
// npm run migrate -- --check list pending migrations, exit 1 if any
// npm run migrate -- --expect-database=SnakeArcadeTest
//                            SQL Server only: refuse to migrate unless both the
//                            migration and the app connection point at that
//                            database (the deploy passes the site's database, so
//                            a test env file can never migrate production).
// Uses DB_MIGRATION_CONNECTION_STRING when set (a login with DDL rights),
// otherwise the normal connection settings.
const { loadConfig } = require("../src/config");
const { openDatabase } = require("../src/db");
const { migrate, pendingMigrations } = require("../src/db/migrate");

function argValue(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length).trim() : "";
}

async function databaseName(db) {
  const row = await db.get("SELECT DB_NAME() AS name");
  return row ? String(row.name || "") : "";
}

// Throws unless the connection's current database is `expected`.
async function checkDatabase(db, expected, label) {
  const actual = await databaseName(db);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`The ${label.toLowerCase()} connection points at database "${actual}", but this site uses "${expected}". Fix the env file; nothing was migrated.`);
  }
  console.log(`${label} connection: database ${actual}`);
}

(async () => {
  const config = loadConfig();
  // Only the database settings matter here (no sessions, no email).
  const fatal = config.problems.filter((p) => p.startsWith("DB_"));
  if (fatal.length) {
    fatal.forEach((p) => console.error(p));
    process.exit(1);
  }
  const expected = argValue("expect-database");
  const db = await openDatabase(config.db, { forMigrations: true });
  try {
    if (expected && db.dialect === "mssql") {
      await checkDatabase(db, expected, config.db.migrationConnectionString ? "Migration" : "App/migration");
      if (config.db.migrationConnectionString) {
        const appDb = await openDatabase(config.db);
        try {
          await checkDatabase(appDb, expected, "App");
        } finally {
          await appDb.close();
        }
      }
    } else if (expected) {
      console.log(`--expect-database ignored for ${db.dialect}.`);
    }
    if (process.argv.includes("--check")) {
      const pending = await pendingMigrations(db);
      console.log(pending.length ? `Pending: ${pending.map((m) => m.name).join(", ")}` : "Database schema is up to date.");
      process.exitCode = pending.length ? 1 : 0;
      return;
    }
    const result = await migrate(db, { log: console.log });
    console.log(result.applied.length ? `Done. Schema at version ${result.version}.` : `Nothing to do. Schema at version ${result.version}.`);
  } finally {
    await db.close();
  }
})().catch((err) => {
  console.error("Migration failed:", err && (err.stack || err.message));
  process.exit(1);
});
