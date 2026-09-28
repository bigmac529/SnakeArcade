"use strict";
// Microsoft SQL Server adapter (production). Uses the mssql package with its
// default tedious driver (TCP + SQL login), or msnodesqlv8 (Windows
// integrated authentication; install it separately) when
// DB_MSSQL_DRIVER=msnodesqlv8. All values are bound as parameters.

function loadMssql(driver) {
  if (driver === "msnodesqlv8") {
    try {
      return require("mssql/msnodesqlv8");
    } catch (err) {
      throw new Error(`DB_MSSQL_DRIVER=msnodesqlv8 needs the msnodesqlv8 package (npm install msnodesqlv8): ${err.message}`);
    }
  }
  return require("mssql");
}

function poolConfig(sql, cfg, connectionString) {
  if (connectionString) {
    // msnodesqlv8 takes an ODBC string; tedious parses an ADO.NET-style one.
    return cfg.driver === "msnodesqlv8" ? { connectionString } : connectionString;
  }
  return {
    server: cfg.server,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user || undefined,
    password: cfg.password || undefined,
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: cfg.encrypt,
      trustServerCertificate: cfg.trustServerCertificate,
      instanceName: cfg.instance || undefined
    }
  };
}

function bind(sql, request, params) {
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) {
      request.input(key, sql.NVarChar(4000), null);
    } else if (typeof value === "boolean") {
      request.input(key, sql.Bit, value);
    } else if (typeof value === "number") {
      request.input(key, Number.isInteger(value) ? sql.BigInt : sql.Float, value);
    } else {
      const text = String(value);
      request.input(key, text.length <= 4000 ? sql.NVarChar(4000) : sql.NVarChar(sql.MAX), text);
    }
  }
  return request;
}

// SQL Server scripts may contain "GO" batch separators (not T-SQL itself).
function splitBatches(script) {
  return String(script)
    .split(/^\s*GO\s*;?\s*$/gim)
    .map((b) => b.trim())
    .filter(Boolean);
}

async function openMssql(cfg, { connectionString = cfg.connectionString } = {}) {
  const sql = loadMssql(cfg.driver);
  const pool = new sql.ConnectionPool(poolConfig(sql, cfg, connectionString));
  await pool.connect();

  const makeOps = (newRequest) => ({
    all: async (text, params) => (await bind(sql, newRequest(), params).query(text)).recordset || [],
    get: async (text, params) => {
      const rows = (await bind(sql, newRequest(), params).query(text)).recordset || [];
      return rows[0] || null;
    },
    run: async (text, params) => {
      const result = await bind(sql, newRequest(), params).query(text);
      return { changes: (result.rowsAffected || []).reduce((a, b) => a + b, 0) };
    },
    exec: async (script) => {
      for (const batch of splitBatches(script)) {
        await newRequest().batch(batch);
      }
    }
  });
  const ops = makeOps(() => pool.request());

  return {
    dialect: "mssql",
    driver: cfg.driver,
    ...ops,
    transaction: async (fn) => {
      const tx = new sql.Transaction(pool);
      await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
      try {
        const result = await fn(makeOps(() => new sql.Request(tx)));
        await tx.commit();
        return result;
      } catch (err) {
        try {
          await tx.rollback();
        } catch (_) {
          /* already rolled back */
        }
        throw err;
      }
    },
    ping: () => ops.get("SELECT 1 AS ok"),
    isUniqueViolation: (err) => {
      const numbers = [err && err.number, err && err.originalError && err.originalError.info && err.originalError.info.number];
      for (const e of (err && err.precedingErrors) || []) {
        numbers.push(e.number);
      }
      return numbers.includes(2627) || numbers.includes(2601);
    },
    close: () => pool.close()
  };
}

module.exports = { openMssql, splitBatches };
