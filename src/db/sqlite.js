"use strict";
// SQLite adapter for local development and tests. Uses node:sqlite (built
// into Node 22.13+, no native install) and falls back to better-sqlite3 if
// that package is installed. Both drivers are synchronous; every operation
// goes through one queue so a transaction never interleaves with another
// request's statements.
const fs = require("fs");
const path = require("path");

function loadDriver() {
  try {
    const { DatabaseSync } = require("node:sqlite");
    return { name: "node:sqlite", open: (file) => new DatabaseSync(file) };
  } catch (_) {
    /* older Node: try better-sqlite3 */
  }
  try {
    const Database = require("better-sqlite3");
    return { name: "better-sqlite3", open: (file) => new Database(file) };
  } catch (_) {
    throw new Error("SQLite needs Node.js 22.13+ (node:sqlite) or the better-sqlite3 package (npm install better-sqlite3).");
  }
}

function toParams(params) {
  const out = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) {
      out[key] = null;
    } else if (typeof value === "boolean") {
      out[key] = value ? 1 : 0;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function plain(row) {
  return row ? { ...row } : null;
}

function openSqlite({ file }) {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const driver = loadDriver();
  const db = driver.open(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const cache = new Map();
  const prepare = (sql) => {
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      cache.set(sql, stmt);
    }
    return stmt;
  };
  const withParams = (stmt, method, params) => {
    const bound = toParams(params);
    return Object.keys(bound).length ? stmt[method](bound) : stmt[method]();
  };
  const ops = {
    all: async (sql, params) => withParams(prepare(sql), "all", params).map(plain),
    get: async (sql, params) => plain(withParams(prepare(sql), "get", params)),
    run: async (sql, params) => ({ changes: Number(withParams(prepare(sql), "run", params).changes || 0) }),
    exec: async (script) => {
      db.exec(script);
    }
  };

  let queue = Promise.resolve();
  const serial = (fn) => {
    const result = queue.then(fn, fn);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  return {
    dialect: "sqlite",
    driver: driver.name,
    all: (sql, params) => serial(() => ops.all(sql, params)),
    get: (sql, params) => serial(() => ops.get(sql, params)),
    run: (sql, params) => serial(() => ops.run(sql, params)),
    exec: (script) => serial(() => ops.exec(script)),
    transaction: (fn) =>
      serial(async () => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = await fn(ops);
          db.exec("COMMIT");
          return result;
        } catch (err) {
          try {
            db.exec("ROLLBACK");
          } catch (_) {
            /* already rolled back */
          }
          throw err;
        }
      }),
    ping: () => serial(() => ops.get("SELECT 1 AS ok")),
    isUniqueViolation: (err) =>
      Boolean(err) &&
      (err.code === "SQLITE_CONSTRAINT_UNIQUE" ||
        err.code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
        err.errcode === 2067 ||
        err.errcode === 1555 ||
        /UNIQUE constraint failed/i.test(String(err.message || ""))),
    close: async () => {
      await queue;
      db.close();
    }
  };
}

module.exports = { openSqlite };
