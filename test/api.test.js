"use strict";
// API tests: node --test test/  (npm test)
// Runs the real app on a throwaway database: SQLite by default, or SQL Server
// with TEST_DB=mssql and TEST_MSSQL_CONNECTION_STRING (the database must
// exist and be empty; e.g. a LocalDB scratch database).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadConfig } = require("../src/config");
const { openDatabase } = require("../src/db");
const { migrate } = require("../src/db/migrate");
const { createStore } = require("../src/store");
const { createMailer } = require("../src/mail");
const { createApp } = require("../src/app");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "snake-api-"));
const outbox = path.join(tmp, "outbox");
let server;
let base;
let db;
let config;
const logs = [];
const quietLog = { log: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")) };

// Wraps a database so every statement first yields for a few ms, like a
// network round-trip to SQL Server: concurrent requests then really
// interleave between a check and the write that follows it. A transaction
// still runs as one unit (the SQLite adapter queues it whole).
function slowDb(d, ms = 4) {
  const pause = () => new Promise((r) => setTimeout(r, ms));
  const wrap = (q) => ({
    ...q,
    get: async (...a) => (await pause(), q.get(...a)),
    all: async (...a) => (await pause(), q.all(...a)),
    run: async (...a) => (await pause(), q.run(...a))
  });
  return { ...wrap(d), dialect: d.dialect, transaction: (fn) => d.transaction((tx) => fn(wrap(tx))) };
}

async function setup(limits = {}, { slow = false } = {}) {
  const env = {
    NODE_ENV: "test",
    PORT: "0",
    SESSION_SECRET: "test-secret-test-secret-test-secret-1234",
    DB_CLIENT: process.env.TEST_DB === "mssql" ? "mssql" : "sqlite",
    SQLITE_FILE: path.join(tmp, "test.db"),
    DB_CONNECTION_STRING: process.env.TEST_MSSQL_CONNECTION_STRING || "",
    DB_MSSQL_DRIVER: process.env.TEST_MSSQL_DRIVER || "tedious",
    MAIL_OUTBOX_DIR: outbox,
    ...limits
  };
  server = require("http").createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  base = `http://127.0.0.1:${port}`;
  // The app's allowed origin is its public URL: the ephemeral test port.
  config = loadConfig({ ...env, PORT: String(port), PUBLIC_BASE_URL: base }, { loadFile: false });
  assert.deepEqual(config.problems, []);
  db = await openDatabase(config.db);
  await migrate(db);
  const appDb = slow ? slowDb(db) : db;
  const store = createStore(appDb);
  const mailer = createMailer(config.mail, { log: quietLog.log });
  const app = createApp({ config, store, mailer, db: appDb, log: quietLog });
  server.on("request", app);
  return { store };
}

// Minimal cookie-keeping client.
function client() {
  let cookie = "";
  let csrf = "";
  async function call(method, url, body, { headers = {}, origin = base, raw = false } = {}) {
    const h = { ...headers };
    if (origin) {
      h.Origin = origin;
    }
    if (cookie) {
      h.Cookie = cookie;
    }
    if (csrf && !("X-CSRF-Token" in h)) {
      h["X-CSRF-Token"] = csrf;
    }
    let payload;
    if (body !== undefined) {
      if (raw) {
        payload = body;
      } else {
        h["Content-Type"] = "application/json";
        payload = JSON.stringify(body);
      }
    }
    const res = await fetch(base + url, { method, headers: h, body: payload, redirect: "manual" });
    const setCookie = res.headers.getSetCookie();
    for (const c of setCookie) {
      const [pair] = c.split(";");
      const value = pair.slice(pair.indexOf("=") + 1);
      cookie = value ? pair : "";
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (json && json.csrfToken) {
      csrf = json.csrfToken;
    }
    return { status: res.status, body: json, headers: res.headers, setCookie, text };
  }
  return {
    get: (url, opts) => call("GET", url, undefined, opts),
    post: (url, body, opts) => call("POST", url, body, opts),
    get cookie() {
      return cookie;
    },
    set cookie(v) {
      cookie = v;
    },
    get csrf() {
      return csrf;
    },
    set csrf(v) {
      csrf = v;
    }
  };
}

function mails(to, kind) {
  if (!fs.existsSync(outbox)) {
    return [];
  }
  return fs
    .readdirSync(outbox)
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(outbox, f), "utf8")))
    .filter((m) => m.to.toLowerCase() === to.toLowerCase() && (!kind || m.kind === kind));
}
function lastToken(to, kind) {
  const list = mails(to, kind);
  assert.ok(list.length, `expected a ${kind} email to ${to}`);
  const m = list[list.length - 1].text.match(/[?&](?:verify|reset)=([A-Za-z0-9_-]+)/);
  return m[1];
}

let n = 0;
const uniq = () => `${Date.now().toString(36)}${(n++).toString(36)}`;
const PASSWORD = "correct horse battery";

async function signup(c, { email, displayName, password = PASSWORD } = {}) {
  const id = uniq();
  email = email || `player${id}@example.com`;
  displayName = displayName || `Player ${id}`.slice(0, 24);
  const res = await c.post("/api/auth/signup", { email, displayName, password });
  return { res, email, displayName, password };
}
async function verifiedUser(opts) {
  const c = client();
  const s = await signup(c, opts);
  assert.equal(s.res.status, 201, JSON.stringify(s.res.body));
  const v = await c.post("/api/auth/verify", { token: lastToken(s.email, "verify") });
  assert.equal(v.status, 200);
  return { c, ...s };
}

test.before(async () => {
  await setup({ RATE_LIMIT_LOGIN_IP_PER_15MIN: "1000", RATE_LIMIT_SIGNUP_PER_HOUR: "1000", RATE_LIMIT_FORGOT_IP_PER_HOUR: "1000" });
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  if (db.dialect === "mssql") {
    for (const t of ["sessions", "email_tokens", "player_scores", "legacy_scores", "users", "app_meta", "schema_migrations"]) {
      await db.exec(`IF OBJECT_ID(N'dbo.${t}', N'U') IS NOT NULL DROP TABLE dbo.${t}`);
    }
  }
  await db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("health reports the database dialect", async () => {
  const r = await client().get("/api/health");
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.db, db.dialect);
  assert.equal(r.body.build, undefined, "a plain checkout has no build-info.json");
});

test("a malformed Cookie header is ignored (signed out), not a crash", async () => {
  const { parseCookies } = require("../src/auth/session");
  assert.deepEqual(parseCookies("a=%; b=ok%20x; c=%E0%A4%A"), { b: "ok x" });
  for (const value of ["x=%", `${require("../src/auth/session").cookieName(config)}=%E0%A4%A`]) {
    const r = await fetch(`${base}/api/auth/me`, { headers: { Cookie: value } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).signedIn, false);
  }
  const h = await client().get("/api/health");
  assert.equal(h.status, 200, "server still up");
});

test("health reports the release build when build-info.json exists", async () => {
  const { readBuildInfo } = require("../src/config");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snake-build-"));
  try {
    assert.equal(readBuildInfo(dir), null);
    fs.writeFileSync(path.join(dir, "build-info.json"), JSON.stringify({ tag: "build-7-abcdef1", number: 7, sha: "abcdef1".padEnd(40, "0"), builtAt: "2026-10-01T12:00:00Z", runUrl: "x" }));
    const build = readBuildInfo(dir);
    assert.deepEqual(build, { tag: "build-7-abcdef1", sha: "abcdef1".padEnd(40, "0"), builtAt: "2026-10-01T12:00:00Z" });
    config.build = build;
    const r = await client().get("/api/health");
    assert.deepEqual(r.body.build, build);
  } finally {
    config.build = null;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("signup creates an unverified signed-in account and emails a link", async () => {
  const c = client();
  const s = await signup(c);
  assert.equal(s.res.status, 201);
  assert.equal(s.res.body.signedIn, true);
  assert.equal(s.res.body.user.verified, false);
  assert.equal(s.res.body.user.displayName, s.displayName);
  assert.ok(s.res.body.csrfToken);
  const cookieHeader = s.res.setCookie.join("\n");
  assert.match(cookieHeader, /HttpOnly/);
  assert.match(cookieHeader, /SameSite=Lax/);
  const list = mails(s.email, "verify");
  assert.equal(list.length, 1);
  assert.match(list[0].text, new RegExp(`${base}/\\?verify=`));
  const me = await c.get("/api/auth/me");
  assert.equal(me.body.signedIn, true);
  assert.equal(me.body.user.verified, false);
});

test("signup validation: bad email, short password, password = email, PG filter, name length", async () => {
  const c = client();
  assert.equal((await c.post("/api/auth/signup", { email: "nope", displayName: "Okay Name", password: PASSWORD })).body.error, "email_invalid");
  assert.equal((await c.post("/api/auth/signup", { email: `a${uniq()}@example.com`, displayName: "Okay Name", password: "short" })).body.error, "password_invalid");
  const e = `same${uniq()}@example.com`;
  assert.equal((await c.post("/api/auth/signup", { email: e, displayName: "Okay Name", password: e })).body.error, "password_invalid");
  const pg = Buffer.from("c2hpdA==", "base64").toString();
  const bad = await c.post("/api/auth/signup", { email: `b${uniq()}@example.com`, displayName: `Big ${pg}`, password: PASSWORD });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "displayName_rejected");
  assert.equal((await c.post("/api/auth/signup", { email: `c${uniq()}@example.com`, displayName: "A", password: PASSWORD })).body.error, "displayName_rejected");
});

test("email and display name are unique, case-insensitively", async () => {
  const a = await verifiedUser();
  const c = client();
  const dupEmail = await c.post("/api/auth/signup", { email: a.email.toUpperCase(), displayName: `Other ${uniq()}`.slice(0, 24), password: PASSWORD });
  assert.equal(dupEmail.status, 409);
  assert.equal(dupEmail.body.error, "email_taken");
  const dupName = await c.post("/api/auth/signup", { email: `x${uniq()}@example.com`, displayName: a.displayName.toUpperCase(), password: PASSWORD });
  assert.equal(dupName.status, 409);
  assert.equal(dupName.body.error, "name_taken");
});

test("verification link is single use and signs nobody in", async () => {
  const c = client();
  const s = await signup(c);
  const token = lastToken(s.email, "verify");
  const anon = client();
  const v1 = await anon.post("/api/auth/verify", { token });
  assert.equal(v1.status, 200);
  assert.equal(v1.body.verified, true);
  assert.equal(v1.body.signedIn, false);
  assert.equal(anon.cookie, "");
  const v2 = await anon.post("/api/auth/verify", { token });
  assert.equal(v2.status, 400);
  assert.equal(v2.body.error, "token_invalid");
  const me = await c.get("/api/auth/me");
  assert.equal(me.body.user.verified, true);
});

test("expired verification link is rejected; bad tokens too", async () => {
  const c = client();
  const s = await signup(c);
  const token = lastToken(s.email, "verify");
  await db.run("UPDATE email_tokens SET expires_at = @t WHERE user_id = @u", { t: Date.now() - 1000, u: s.res.body.user.id });
  const r = await c.post("/api/auth/verify", { token });
  assert.equal(r.status, 400);
  assert.equal((await c.post("/api/auth/verify", { token: "x" })).status, 400);
  assert.equal((await c.post("/api/auth/verify", { token: "A".repeat(43) })).status, 400);
  assert.equal((await c.get("/api/auth/me")).body.user.verified, false);
});

test("tokens and session ids are stored hashed", async () => {
  const c = client();
  const s = await signup(c);
  const token = lastToken(s.email, "verify");
  const rows = await db.all("SELECT token_hash FROM email_tokens WHERE user_id = @u", { u: s.res.body.user.id });
  assert.ok(rows.length);
  assert.ok(rows.every((r) => r.token_hash.trim() !== token && /^[0-9a-f]{64}$/.test(r.token_hash.trim())));
  const sid = c.cookie.split("=")[1];
  const sessions = await db.all("SELECT id_hash FROM sessions WHERE user_id = @u", { u: s.res.body.user.id });
  assert.ok(sessions.every((r) => r.id_hash.trim() !== sid));
  const user = await db.get("SELECT password_hash FROM users WHERE id = @u", { u: s.res.body.user.id });
  assert.match(user.password_hash, /^scrypt\$32768\$8\$1\$/);
  assert.ok(!user.password_hash.includes(PASSWORD));
});

test("unverified accounts can't post scores (403), signed-out gets 401", async () => {
  const c = client();
  await signup(c);
  const r = await c.post("/api/score", { score: 50, difficulty: "normal", epoch: 0 });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "email_unverified");
  const anon = client();
  const r2 = await anon.post("/api/score", { score: 50 });
  assert.equal(r2.status, 401);
  assert.equal(r2.body.error, "signed_out");
});

test("resend verification: cooldown and daily cap", async () => {
  const c = client();
  const s = await signup(c);
  const first = await c.post("/api/auth/resend-verification", {});
  assert.equal(first.status, 429, "signup just sent one: cooldown applies");
  assert.ok(first.headers.get("retry-after"));
  // Pretend the earlier emails were sent long ago.
  const u = s.res.body.user.id;
  await db.run("UPDATE email_tokens SET created_at = created_at - @d WHERE user_id = @u", { d: 120000, u });
  const ok = await c.post("/api/auth/resend-verification", {});
  assert.equal(ok.status, 200);
  assert.equal(ok.body.sent, true);
  assert.equal(mails(s.email, "verify").length, 2);
  for (let i = 0; i < 3; i += 1) {
    await db.run("UPDATE email_tokens SET created_at = created_at - @d WHERE user_id = @u", { d: 120000, u });
    assert.equal((await c.post("/api/auth/resend-verification", {})).status, 200);
  }
  await db.run("UPDATE email_tokens SET created_at = created_at - @d WHERE user_id = @u", { d: 120000, u });
  const capped = await c.post("/api/auth/resend-verification", {});
  assert.equal(capped.status, 429, "5 per day");
  // The newest link works; the old ones were retired when it was used.
  const newest = lastToken(s.email, "verify");
  assert.equal((await c.post("/api/auth/verify", { token: newest })).status, 200);
  assert.equal((await c.post("/api/auth/resend-verification", {})).body.alreadyVerified, true);
});

test("login / logout; wrong password and unknown email get the same generic error", async () => {
  const a = await verifiedUser();
  const c = client();
  const bad = await c.post("/api/auth/login", { email: a.email, password: "wrong password!!" });
  const unknown = await c.post("/api/auth/login", { email: `nobody${uniq()}@example.com`, password: "wrong password!!" });
  assert.equal(bad.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(bad.body, unknown.body);
  assert.equal(c.cookie, "");
  const good = await c.post("/api/auth/login", { email: a.email.toUpperCase(), password: a.password });
  assert.equal(good.status, 200);
  assert.equal(good.body.user.displayName, a.displayName);
  assert.equal(good.body.user.verified, true);
  assert.ok(!JSON.stringify(good.body).includes("password"));
  const out = await c.post("/api/auth/logout", {});
  assert.equal(out.status, 200);
  assert.match(out.setCookie.join(""), /Max-Age=0/);
  assert.equal((await c.get("/api/auth/me")).body.signedIn, false);
});

test("logged-out session id can't be replayed", async () => {
  const a = await verifiedUser();
  const stolen = a.c.cookie;
  const csrf = a.c.csrf;
  await a.c.post("/api/auth/logout", {});
  const replay = client();
  replay.cookie = stolen;
  replay.csrf = csrf;
  assert.equal((await replay.get("/api/auth/me")).body.signedIn, false);
  assert.equal((await replay.post("/api/score", { score: 5 })).status, 401);
});

test("login rate limit per account", async () => {
  const a = await verifiedUser();
  const c = client();
  let last;
  for (let i = 0; i < 11; i += 1) {
    last = await c.post("/api/auth/login", { email: a.email, password: "wrong password!!" });
  }
  assert.equal(last.status, 429);
  assert.equal(last.body.error, "rate_limited");
  // Even the right password waits until the window ends.
  assert.equal((await c.post("/api/auth/login", { email: a.email, password: a.password })).status, 429);
});

test("CSRF: missing or wrong token, foreign origin, and non-JSON are rejected", async () => {
  const a = await verifiedUser();
  const noToken = await a.c.post("/api/score", { score: 10 }, { headers: { "X-CSRF-Token": "" } });
  assert.equal(noToken.status, 403);
  assert.equal(noToken.body.error, "csrf_failed");
  const wrong = await a.c.post("/api/score", { score: 10 }, { headers: { "X-CSRF-Token": "forged" } });
  assert.equal(wrong.status, 403);
  const evil = await a.c.post("/api/score", { score: 10 }, { origin: "https://evil.example" });
  assert.equal(evil.status, 403);
  assert.equal(evil.body.error, "bad_origin");
  const noOrigin = await a.c.post("/api/score", { score: 10 }, { origin: "" });
  assert.equal(noOrigin.status, 403);
  const form = await a.c.post("/api/score", "score=10", { raw: true, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  assert.equal(form.status, 415);
  const loginEvil = await client().post("/api/auth/login", { email: a.email, password: a.password }, { origin: "https://evil.example" });
  assert.equal(loginEvil.status, 403);
  // Another account's CSRF token doesn't work with this session.
  const b = await verifiedUser();
  const swapped = await a.c.post("/api/score", { score: 10 }, { headers: { "X-CSRF-Token": b.c.csrf } });
  assert.equal(swapped.status, 403);
  assert.equal((await a.c.get("/api/auth/me")).body.user.best, 0);
});

test("scores: keep the higher, per account, body identity ignored", async () => {
  const a = await verifiedUser();
  const b = await verifiedUser();
  const r1 = await a.c.post("/api/score", { score: 120, difficulty: "hard", epoch: 0 });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.improved, true);
  assert.equal(r1.body.player.best, 120);
  const r2 = await a.c.post("/api/score", { score: 40, difficulty: "easy", epoch: 0 });
  assert.equal(r2.body.improved, false);
  assert.equal(r2.body.player.best, 120);
  assert.equal(r2.body.player.bestDifficulty, "hard");
  // Spoofing another player in the body changes nothing for them.
  const spoof = await a.c.post("/api/score", { score: 999, epoch: 0, playerName: b.displayName, userId: b.res.body.user.id, user: { id: b.res.body.user.id } });
  assert.equal(spoof.status, 200);
  assert.equal(spoof.body.player.playerName, a.displayName);
  assert.equal(spoof.body.player.best, 999);
  assert.equal((await b.c.get("/api/auth/me")).body.user.best, 0);
  // A run that started under another account is refused, never re-credited.
  const switched = await b.c.post("/api/score", { score: 555, epoch: 0, runAccount: a.res.body.user.id });
  assert.equal(switched.status, 409);
  assert.equal(switched.body.error, "account_changed");
  assert.equal((await b.c.post("/api/score", { score: 5, epoch: 0, runAccount: b.res.body.user.id })).body.player.best, 5);
  await b.c.post("/api/reset-best", {});
  const board = (await client().get("/api/players")).body.players;
  assert.ok(board.some((p) => p.playerName === a.displayName && p.best === 999));
  assert.ok(!board.some((p) => p.playerName === b.displayName));
  assert.equal((await a.c.post("/api/score", { score: -1, epoch: 0 })).status, 400);
  assert.equal((await a.c.post("/api/score", { score: 1.5, epoch: 0 })).status, 400);
  assert.equal((await a.c.post("/api/score", { score: "abc", epoch: 0 })).status, 400);
  // The run's epoch is required and must be the current one.
  for (const epoch of [undefined, null, "", "x", -1, 0.5]) {
    const r = await a.c.post("/api/score", { score: 5000, ...(epoch === undefined ? {} : { epoch }) });
    assert.equal(r.status, 400, `epoch ${JSON.stringify(epoch)}`);
    assert.equal(r.body.error, "epoch_invalid");
  }
  const future = await a.c.post("/api/score", { score: 5000, epoch: 7 });
  assert.equal(future.status, 200);
  assert.equal(future.body.stale, true, "an epoch the account never had is stale");
  assert.equal(future.body.player.best, 999);
});

test("scores: a reset that lands mid-save can't be undone by the old save (atomic UPDATE)", async () => {
  // Simulates SQL Server READ COMMITTED: another session's Reset best score
  // commits between whatever the save reads and its UPDATE. Injected right
  // before the save's first write, inside its transaction.
  const { createStore } = require("../src/store");
  const a = await verifiedUser();
  const userId = a.res.body.user.id;
  assert.equal((await a.c.post("/api/score", { score: 300, epoch: 0 })).body.player.best, 300);
  let injected = false;
  const racyDb = {
    ...db,
    dialect: db.dialect,
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          ...tx,
          run: async (sql, params) => {
            if (!injected && /UPDATE player_scores SET best = @score/.test(sql)) {
              injected = true;
              await tx.run("UPDATE player_scores SET best = 0, best_difficulty = NULL, score_epoch = score_epoch + 1 WHERE user_id = @u", { u: userId });
            }
            return tx.run(sql, params);
          }
        })
      )
  };
  const result = await createStore(racyDb).submitScore(userId, 250, "hard", 0);
  assert.ok(injected, "the reset was injected");
  assert.equal(result.improved, false);
  assert.equal(result.stale, true);
  const me = (await a.c.get("/api/auth/me")).body.user;
  assert.equal(me.best, 0, "the pre-reset save must not restore a score");
  assert.equal(me.scoreEpoch, 1);
});

test("scores: parallel saves and a reset: no lower or pre-reset score survives", async () => {
  const a = await verifiedUser();
  const saves = [];
  for (let i = 1; i <= 20; i += 1) {
    saves.push(a.c.post("/api/score", { score: i * 10, epoch: 0 }));
    if (i === 10) {
      saves.push(a.c.post("/api/reset-best", {}));
    }
  }
  await Promise.all(saves);
  const me = (await a.c.get("/api/auth/me")).body.user;
  assert.equal(me.scoreEpoch, 1);
  // Every epoch-0 save either landed before the reset (then wiped) or after it (stale): best is 0.
  assert.equal(me.best, 0);
  const after = await Promise.all([30, 90, 60].map((score) => a.c.post("/api/score", { score, epoch: 1 })));
  assert.ok(after.every((r) => r.status === 200));
  assert.equal((await a.c.get("/api/auth/me")).body.user.best, 90, "the higher of parallel saves wins");
});

test("reset best: only the signed-in account, old-epoch saves are ignored", async () => {
  const a = await verifiedUser();
  const b = await verifiedUser();
  await a.c.post("/api/score", { score: 300, epoch: 0 });
  await b.c.post("/api/score", { score: 200, epoch: 0 });
  const reset = await a.c.post("/api/reset-best", { playerName: b.displayName });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.previousBest, 300);
  assert.equal(reset.body.player.best, 0);
  assert.equal(reset.body.player.scoreEpoch, 1);
  assert.equal((await b.c.get("/api/auth/me")).body.user.best, 200, "other account untouched");
  const stale = await a.c.post("/api/score", { score: 250, epoch: 0 });
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.player.best, 0);
  const fresh = await a.c.post("/api/score", { score: 20, epoch: 1 });
  assert.equal(fresh.body.player.best, 20);
  assert.equal((await client().post("/api/reset-best", {})).status, 401);
});

test("edit display name: uniqueness, PG filter, best stays with the account", async () => {
  const a = await verifiedUser();
  const b = await verifiedUser();
  await a.c.post("/api/score", { score: 77, epoch: 0 });
  const taken = await a.c.post("/api/account/name", { displayName: b.displayName.toLowerCase() });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error, "name_taken");
  const pg = Buffer.from("c2hpdA==", "base64").toString();
  const rude = await a.c.post("/api/account/name", { displayName: `x${pg}x` });
  assert.equal(rude.status, 400);
  const newName = `Renamed ${uniq()}`.slice(0, 24);
  const ok = await a.c.post("/api/account/name", { displayName: newName });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.displayName, newName);
  assert.equal(ok.body.user.best, 77);
  assert.ok(ok.body.players.some((p) => p.playerName === newName && p.best === 77 && p.isYou));
  assert.ok(!ok.body.players.some((p) => p.playerName === a.displayName));
  // Changing only the capitalisation of your own name is allowed.
  const recase = await a.c.post("/api/account/name", { displayName: newName.toUpperCase() });
  assert.equal(recase.status, 200);
  // The old name is free again.
  const c = client();
  const reuse = await c.post("/api/auth/signup", { email: `r${uniq()}@example.com`, displayName: a.displayName, password: PASSWORD });
  assert.equal(reuse.status, 201);
  assert.equal((await client().post("/api/account/name", { displayName: "Whoever" })).status, 401);
});

test("password reset: generic answer, single-use link, sessions revoked", async () => {
  const a = await verifiedUser();
  const other = client();
  await other.post("/api/auth/login", { email: a.email, password: a.password });
  const anon = client();
  const unknown = await anon.post("/api/auth/forgot", { email: `ghost${uniq()}@example.com` });
  const known = await anon.post("/api/auth/forgot", { email: a.email });
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body, known.body);
  let token;
  for (let i = 0; i < 50 && !token; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
    if (mails(a.email, "reset").length) {
      token = lastToken(a.email, "reset");
    }
  }
  assert.ok(token, "reset email written");
  const weak = await anon.post("/api/auth/reset", { token, password: "short" });
  assert.equal(weak.status, 400);
  assert.equal(weak.body.error, "password_invalid");
  const newPassword = "a brand new passphrase";
  const done = await anon.post("/api/auth/reset", { token, password: newPassword });
  assert.equal(done.status, 200);
  assert.equal(done.body.signedIn, true);
  assert.equal((await anon.post("/api/auth/reset", { token, password: "another new passphrase" })).status, 400);
  assert.equal((await a.c.get("/api/auth/me")).body.signedIn, false, "old sessions revoked");
  assert.equal((await other.get("/api/auth/me")).body.signedIn, false);
  assert.equal((await client().post("/api/auth/login", { email: a.email, password: a.password })).status, 401);
  assert.equal((await client().post("/api/auth/login", { email: a.email, password: newPassword })).status, 200);
});

test("forgot password: per-account hourly cap", async () => {
  const a = await verifiedUser();
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await client().post("/api/auth/forgot", { email: a.email })).status, 200);
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(mails(a.email, "reset").length, 3);
});

test("public leaderboard: no auth, no emails, only verified accounts with a score", async () => {
  const a = await verifiedUser();
  await a.c.post("/api/score", { score: 64, epoch: 0 });
  const r = await client().get("/api/players");
  assert.equal(r.status, 200);
  assert.ok(Number.isInteger(r.body.revision));
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes("@"), "no emails anywhere on the board");
  assert.ok(!/email|password|id_hash|user_id/.test(text));
  assert.ok(r.body.players.every((p) => !p.isYou));
  const mine = await a.c.get("/api/players");
  assert.ok(mine.body.players.some((p) => p.isYou && p.playerName === a.displayName));
  assert.ok(!r.body.players.some((p) => p.best === 0));
});

test("the old /api/settings endpoints are gone", async () => {
  const c = client();
  assert.equal((await c.get("/api/settings?player=x")).status, 404);
  assert.equal((await c.post("/api/settings", { playerName: "x" })).status, 404);
});

test("static files: only public/ is served, with security headers", async () => {
  const c = client();
  const home = await c.get("/");
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
  assert.equal(home.headers.get("x-powered-by"), null);
  assert.equal(home.headers.get("referrer-policy"), "no-referrer");
  for (const p of ["/data/settings.json", "/server.js", "/package.json", "/scripts/deploy.ps1", "/src/app.js", "/.env", "/migrations/sqlite/001_accounts.sql"]) {
    assert.equal((await c.get(p)).status, 404, p);
  }
  assert.equal((await c.get("/game.js")).status, 200);
});

test("oversized and malformed bodies are rejected", async () => {
  const c = client();
  const big = await c.post("/api/auth/login", { email: "a@b.co", password: "x".repeat(20000) });
  assert.equal(big.status, 413);
  const broken = await c.post("/api/auth/login", "{not json", { raw: true, headers: { "Content-Type": "application/json" } });
  assert.equal(broken.status, 400);
});

test("logs never contain full email addresses", async () => {
  const a = await verifiedUser();
  await client().post("/api/auth/login", { email: a.email, password: a.password });
  await client().post("/api/auth/forgot", { email: a.email });
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(logs.length > 0);
  for (const line of logs) {
    assert.ok(!line.includes(a.email), line);
  }
});

async function restart(limits, opts) {
  await new Promise((r) => server.close(r));
  await db.close();
  await setup({ RATE_LIMIT_LOGIN_IP_PER_15MIN: "1000", RATE_LIMIT_SIGNUP_PER_HOUR: "1000", RATE_LIMIT_FORGOT_IP_PER_HOUR: "1000", ...limits }, opts);
}

test("resend verification: parallel requests can't beat the cooldown", async () => {
  await restart({}, { slow: true });
  const c = client();
  const s = await signup(c);
  await db.run("UPDATE email_tokens SET created_at = created_at - @d WHERE user_id = @u", { d: 120000, u: s.res.body.user.id });
  const rs = await Promise.all(Array.from({ length: 12 }, () => c.post("/api/auth/resend-verification", {})));
  assert.equal(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join(","));
  assert.ok(rs.filter((r) => r.status === 429).every((r) => Number(r.headers.get("retry-after")) >= 1));
  assert.equal(mails(s.email, "verify").length, 2, "sign-up email + exactly one resend");
});

test("resend verification and forgot password: parallel requests can't beat the caps", async () => {
  await restart({ RATE_LIMIT_RESEND_COOLDOWN_SECONDS: "0", RATE_LIMIT_RESEND_PER_DAY: "3", RATE_LIMIT_FORGOT_PER_HOUR: "2" }, { slow: true });
  const c = client();
  const s = await signup(c);
  const rs = await Promise.all(Array.from({ length: 15 }, () => c.post("/api/auth/resend-verification", {})));
  // The sign-up email counts toward the 3 per day.
  assert.equal(rs.filter((r) => r.status === 200).length, 2, rs.map((r) => r.status).join(","));
  assert.equal(mails(s.email, "verify").length, 3);
  const n = Number((await db.get("SELECT COUNT(*) AS n FROM email_tokens WHERE user_id = @u AND purpose = @p", { u: s.res.body.user.id, p: "verify" })).n);
  assert.equal(n, 3, "no extra tokens were created either");

  const a = await verifiedUser();
  const fs2 = await Promise.all(Array.from({ length: 15 }, () => client().post("/api/auth/forgot", { email: a.email })));
  assert.ok(fs2.every((r) => r.status === 200), "always the same answer");
  for (let i = 0; i < 40 && mails(a.email, "reset").length < 2; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(mails(a.email, "reset").length, 2);
  const m = Number((await db.get("SELECT COUNT(*) AS n FROM email_tokens WHERE user_id = @u AND purpose = @p", { u: a.res.body.user.id, p: "reset" })).n);
  assert.equal(m, 2);
});

test("signup rate limit per IP", async () => {
  await new Promise((r) => server.close(r));
  await db.close();
  await setup({ RATE_LIMIT_SIGNUP_PER_HOUR: "2" });
  const c = client();
  assert.equal((await signup(c)).res.status, 201);
  assert.equal((await signup(client())).res.status, 201);
  const third = await signup(client());
  assert.equal(third.res.status, 429);
});

test("env file parsing: comments, quotes, inline comments", () => {
  const { parseEnvFile } = require("../src/config");
  const parsed = parseEnvFile(["# comment", "PORT=3105   # service port", "A=\"abc #123\"", "B=p#ss", "export C='q'", "", "BAD LINE"].join("\r\n"));
  assert.deepEqual(parsed, { PORT: "3105", A: "abc #123", B: "p#ss", C: "q" });
});

test("production config: session secret, DB_CLIENT and SMTP required (outbox only by explicit opt-in)", () => {
  const { loadConfig } = require("../src/config");
  const bad = loadConfig({ NODE_ENV: "production" }, { loadFile: false });
  assert.ok(bad.problems.some((p) => p.startsWith("SESSION_SECRET")));
  assert.ok(bad.problems.some((p) => p.startsWith("DB_CLIENT is required")), "no silent SQLite in production");
  assert.ok(bad.problems.some((p) => p.startsWith("SMTP_HOST is required")), "no silent outbox in production");
  const base = {
    NODE_ENV: "production",
    SESSION_SECRET: "x".repeat(40),
    PUBLIC_BASE_URL: "https://snakearcade.socha3.com",
    DB_CLIENT: "mssql",
    DB_CONNECTION_STRING: "Server=x;Database=SnakeArcade;User Id=a;Password=b"
  };
  const smtp = loadConfig({ ...base, SMTP_HOST: "mail.example.com", SMTP_PORT: "465" }, { loadFile: false });
  assert.deepEqual(smtp.problems, []);
  assert.equal(smtp.cookieSecure, true);
  assert.equal(smtp.mail.secure, true);
  assert.equal(smtp.mail.mode, "smtp");
  const outbox = loadConfig({ ...base, MAIL_TRANSPORT: "outbox" }, { loadFile: false });
  assert.deepEqual(outbox.problems, []);
  assert.equal(outbox.mail.mode, "outbox");
  assert.ok(outbox.warnings.some((w) => w.includes("MAIL_TRANSPORT=outbox")));
  assert.ok(loadConfig({ ...base, MAIL_TRANSPORT: "carrier-pigeon" }, { loadFile: false }).problems.some((p) => p.startsWith("MAIL_TRANSPORT must be")));
  assert.ok(loadConfig({ ...base, MAIL_TRANSPORT: "smtp" }, { loadFile: false }).problems.some((p) => p.startsWith("MAIL_TRANSPORT=smtp needs SMTP_HOST")));
  const sqliteProd = loadConfig({ ...base, DB_CLIENT: "sqlite", SMTP_HOST: "mail.example.com" }, { loadFile: false });
  assert.deepEqual(sqliteProd.problems, [], "SQLite in production only when chosen explicitly");
  assert.ok(sqliteProd.warnings.some((w) => w.startsWith("DB_CLIENT=sqlite")));
  // Local dev / tests: SQLite + outbox by default, no problems.
  const dev = loadConfig({}, { loadFile: false });
  assert.deepEqual(dev.problems, []);
  assert.equal(dev.db.client, "sqlite");
  assert.equal(dev.mail.mode, "outbox");
});
