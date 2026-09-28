"use strict";
// Opens the configured database (DB_CLIENT=sqlite|mssql) behind one small
// interface: all / get / run / exec / transaction / ping / close, with
// named @parameters in SQL. The data-access layer (src/store.js) only uses
// this interface, so the engine can be swapped.
const { openSqlite } = require("./sqlite");
const { openMssql } = require("./mssql");

async function openDatabase(dbConfig, { forMigrations = false } = {}) {
  if (dbConfig.client === "mssql") {
    const connectionString = forMigrations && dbConfig.migrationConnectionString
      ? dbConfig.migrationConnectionString
      : dbConfig.connectionString;
    return openMssql(dbConfig, { connectionString });
  }
  return openSqlite({ file: dbConfig.sqliteFile });
}

module.exports = { openDatabase };
