"use strict";
// SnakeArcade server entry point: load config, open the database (SQL Server
// in production, SQLite locally), apply pending migrations, start listening.
const { loadConfig } = require("./src/config");
const { openDatabase } = require("./src/db");
const { migrate, pendingMigrations } = require("./src/db/migrate");
const { createStore } = require("./src/store");
const { createMailer } = require("./src/mail");
const { createApp } = require("./src/app");

async function main() {
  const config = loadConfig();
  for (const w of config.warnings) {
    console.warn(`[config] warning: ${w}`);
  }
  if (config.problems.length) {
    for (const p of config.problems) {
      console.error(`[config] ${p}`);
    }
    console.error("[config] Fix the settings above (see README / docs/database-setup.md). Not starting.");
    process.exit(1);
  }

  if (config.db.migrateOnStart) {
    // Migrations may use a separate login with DDL rights.
    const migrationDb = await openDatabase(config.db, { forMigrations: true });
    try {
      const result = await migrate(migrationDb, { log: (m) => console.log(`[db] ${m}`) });
      console.log(`[db] schema at version ${result.version}`);
    } finally {
      await migrationDb.close();
    }
  }

  const db = await openDatabase(config.db);
  const pending = await pendingMigrations(db);
  if (pending.length) {
    console.error(`[db] ${pending.length} migration(s) not applied: ${pending.map((m) => m.name).join(", ")}. Run "npm run migrate". Not starting.`);
    process.exit(1);
  }
  const store = createStore(db);
  const mailer = createMailer(config.mail);
  const app = createApp({ config, store, mailer, db });

  const purge = () => store.purgeExpired().catch((err) => console.error("[db] cleanup failed:", err && err.message));
  purge();
  setInterval(purge, 6 * 3600 * 1000).unref();

  const server = app.listen(config.port, config.host, () => {
    console.log(`SnakeArcade listening on http://${config.host}:${config.port} (db: ${db.dialect}, mail: ${mailer.mode})`);
  });

  const shutdown = () => {
    server.close(() => db.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("SnakeArcade failed to start:", err && (err.stack || err.message));
  process.exit(1);
});
