"use strict";
// Configuration from environment variables (documented in README and
// .env.example). An env file can supply them too: SNAKEARCADE_ENV_FILE names
// it (put it outside the web root on the server), otherwise ".env" in the app
// folder is used if present. Variables already set in the environment (for
// example in the WinSW service XML) always win over the file.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");

function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    } else {
      // Unquoted: whitespace + "#" starts a comment (quote values that contain " #").
      const hash = value.search(/\s#/);
      if (hash >= 0) {
        value = value.slice(0, hash).trim();
      }
    }
    out[key] = value;
  }
  return out;
}

function loadEnvFile(env) {
  const explicit = env.SNAKEARCADE_ENV_FILE;
  const file = explicit || path.join(ROOT, ".env");
  if (!fs.existsSync(file)) {
    if (explicit) {
      throw new Error(`SNAKEARCADE_ENV_FILE points to a missing file: ${explicit}`);
    }
    return null;
  }
  const values = parseEnvFile(fs.readFileSync(file, "utf8"));
  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined) {
      env[key] = value;
    }
  }
  return file;
}

// Which release build is running: build-info.json is written into every build
// zip by the release pipeline (absent in a plain checkout).
function readBuildInfo(root = ROOT) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(root, "build-info.json"), "utf8"));
    return info && info.tag ? { tag: String(info.tag), sha: String(info.sha || ""), builtAt: String(info.builtAt || "") } : null;
  } catch {
    return null;
  }
}

function bool(value, fallback) {
  if (value === undefined || value === "") {
    return fallback;
  }
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function int(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) ? Math.floor(n) : fallback;
}

function loadConfig(env = process.env, { loadFile = true } = {}) {
  const envFile = loadFile ? loadEnvFile(env) : null;
  const production = env.NODE_ENV === "production";
  const port = int(env.PORT, 3023);
  const publicBaseUrl = String(env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, "");
  // problems stop the server from starting; warnings are only logged.
  const problems = [];
  const warnings = [];

  let sessionSecret = env.SESSION_SECRET || "";
  if (!sessionSecret) {
    if (production) {
      problems.push("SESSION_SECRET is required in production (32+ random characters).");
    }
    // Dev only: a random secret per start (CSRF tokens change on restart;
    // the page fetches a fresh one automatically).
    sessionSecret = crypto.randomBytes(32).toString("hex");
  } else if (sessionSecret.length < 32) {
    problems.push("SESSION_SECRET must be at least 32 characters.");
  }

  const dbClient = String(env.DB_CLIENT || "sqlite").toLowerCase();
  if (!["sqlite", "mssql"].includes(dbClient)) {
    problems.push(`DB_CLIENT must be "sqlite" or "mssql" (got "${dbClient}").`);
  }

  const smtpHost = env.SMTP_HOST || "";
  const smtpPort = int(env.SMTP_PORT, 587);
  const config = {
    root: ROOT,
    build: readBuildInfo(ROOT),
    publicDir: path.join(ROOT, "public"),
    envFile,
    production,
    port,
    host: env.HOST || "localhost",
    publicBaseUrl,
    publicOrigin: new URL(publicBaseUrl).origin,
    allowedOrigins: String(env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean),
    trustProxy: bool(env.TRUST_PROXY, true),
    sessionSecret,
    cookieSecure: bool(env.COOKIE_SECURE, production || publicBaseUrl.startsWith("https://")),
    sessionDays: int(env.SESSION_DAYS, 30),
    db: {
      client: dbClient,
      sqliteFile: path.resolve(ROOT, env.SQLITE_FILE || path.join("data", "snakearcade.db")),
      connectionString: env.DB_CONNECTION_STRING || "",
      migrationConnectionString: env.DB_MIGRATION_CONNECTION_STRING || "",
      server: env.DB_SERVER || "",
      port: int(env.DB_PORT, 0) || undefined,
      instance: env.DB_INSTANCE || "",
      database: env.DB_NAME || "SnakeArcade",
      user: env.DB_USER || "",
      password: env.DB_PASSWORD || "",
      encrypt: bool(env.DB_ENCRYPT, true),
      trustServerCertificate: bool(env.DB_TRUST_SERVER_CERTIFICATE, false),
      driver: String(env.DB_MSSQL_DRIVER || "tedious").toLowerCase(),
      migrateOnStart: bool(env.DB_MIGRATE_ON_START, true)
    },
    mail: {
      mode: smtpHost ? "smtp" : "outbox",
      host: smtpHost,
      port: smtpPort,
      // true = TLS from the start (port 465); false = STARTTLS (port 587),
      // which is then required (never falls back to plain text).
      secure: bool(env.SMTP_SECURE, smtpPort === 465),
      user: env.SMTP_USER || "",
      password: env.SMTP_PASSWORD || "",
      from: env.MAIL_FROM || "SnakeArcade <no-reply@socha3.com>",
      replyTo: env.MAIL_REPLY_TO || "",
      outboxDir: path.resolve(ROOT, env.MAIL_OUTBOX_DIR || path.join("data", "outbox"))
    },
    limits: {
      signupPerHourPerIp: int(env.RATE_LIMIT_SIGNUP_PER_HOUR, 5),
      loginPer15MinPerAccount: int(env.RATE_LIMIT_LOGIN_PER_15MIN, 10),
      loginPer15MinPerIp: int(env.RATE_LIMIT_LOGIN_IP_PER_15MIN, 50),
      resendCooldownSeconds: int(env.RATE_LIMIT_RESEND_COOLDOWN_SECONDS, 60),
      resendPerDay: int(env.RATE_LIMIT_RESEND_PER_DAY, 5),
      forgotPerHourPerAccount: int(env.RATE_LIMIT_FORGOT_PER_HOUR, 3),
      forgotPerHourPerIp: int(env.RATE_LIMIT_FORGOT_IP_PER_HOUR, 20)
    },
    tokens: {
      verifyHours: int(env.VERIFY_TOKEN_HOURS, 24),
      resetMinutes: int(env.RESET_TOKEN_MINUTES, 60)
    },
    legacyDataFile: path.join(ROOT, "data", "settings.json")
  };

  if (production && config.mail.mode === "outbox") {
    warnings.push("SMTP_HOST is not set: emails are only written to the local outbox folder, nobody receives them.");
  }
  if (dbClient === "mssql" && !config.db.connectionString && !config.db.server) {
    problems.push("DB_CLIENT=mssql needs DB_CONNECTION_STRING or DB_SERVER (+ DB_NAME, DB_USER, DB_PASSWORD).");
  }
  config.problems = problems;
  config.warnings = warnings;
  return config;
}

module.exports = { loadConfig, parseEnvFile, readBuildInfo };
