"use strict";
// npm run migrate            apply pending migrations
// npm run migrate -- --check list pending migrations, exit 1 if any
// Uses DB_MIGRATION_CONNECTION_STRING when set (a login with DDL rights),
// otherwise the normal connection settings.
const { loadConfig } = require("../src/config");
const { openDatabase } = require("../src/db");
const { migrate, pendingMigrations } = require("../src/db/migrate");

(async () => {
  const config = loadConfig();
  const fatal = config.problems.filter((p) => !p.startsWith("SESSION_SECRET"));
  if (fatal.length) {
    fatal.forEach((p) => console.error(p));
    process.exit(1);
  }
  const db = await openDatabase(config.db, { forMigrations: true });
  try {
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
