const express = require("express");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const LOCK_FILE = path.join(DATA_DIR, "settings.json.lock");
const PORT = Number(process.env.PORT) || 3023;

const LOCK_MAX_ATTEMPTS = 12;
const LOCK_BASE_MS = 25;
const LOCK_MAX_MS = 180;

const app = express();
app.use(express.json({ limit: "64kb" }));

function ensureDataStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(SETTINGS_FILE)) {
    atomicWriteJson(SETTINGS_FILE, { revision: 0, players: {} });
  }
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* busy-wait: short lock waits only */
  }
}

function acquireLock() {
  ensureDataStore();
  let lastErr = null;
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      const fd = fs.openSync(LOCK_FILE, "wx");
      fs.writeSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          at: new Date().toISOString()
        })
      );
      return fd;
    } catch (err) {
      lastErr = err;
      if (err && err.code !== "EEXIST") {
        throw err;
      }
      // Stale lock recovery: if lock is older than 8s, steal it.
      try {
        const st = fs.statSync(LOCK_FILE);
        if (Date.now() - st.mtimeMs > 8000) {
          fs.unlinkSync(LOCK_FILE);
          continue;
        }
      } catch (_) {
        /* ignore */
      }
      const jitter = Math.floor(Math.random() * 40);
      const wait = Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** attempt) + jitter;
      sleepSync(wait);
    }
  }
  const busy = new Error("lock_busy");
  busy.code = "lock_busy";
  busy.cause = lastErr;
  throw busy;
}

function releaseLock(fd) {
  try {
    if (fd != null) {
      fs.closeSync(fd);
    }
  } catch (_) {
    /* ignore */
  }
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch (_) {
    /* ignore */
  }
}

function normalizeStore(parsed) {
  const store = parsed && typeof parsed === "object" ? parsed : {};
  if (!store.players || typeof store.players !== "object") {
    store.players = {};
  }
  const rev = Number(store.revision);
  store.revision = Number.isFinite(rev) && rev >= 0 ? Math.floor(rev) : 0;
  return store;
}

function readStoreUnlocked() {
  ensureDataStore();
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
    return normalizeStore(JSON.parse(raw));
  } catch (_) {
    return { revision: 0, players: {} };
  }
}

function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  const tmp = path.join(
    dir,
    `.settings-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`
  );
  fs.writeFileSync(tmp, payload, "utf8");
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Windows cannot always rename over an existing file.
    fs.copyFileSync(tmp, filePath);
    fs.unlinkSync(tmp);
  }
}

function withStoreLock(fn) {
  let fd = null;
  try {
    fd = acquireLock();
    return fn();
  } finally {
    releaseLock(fd);
  }
}

const BLOCKED = JSON.parse(
  Buffer.from(
    "WyJhc3Nob2xlIiwiYXNzd2lwZSIsImJhc3RhcmQiLCJiaXRjaCIsImJvbGxvY2tzIiwiY29jayIsImNyYXAiLCJjdW50IiwiZGFtbiIsImRpY2siLCJkeWtlIiwiZmFnIiwiZmFnZ290IiwiZnVjayIsImZ1Y2tlciIsImZ1Y2tpbmciLCJnb2RkYW1uIiwiaGVsbCIsImphY2thc3MiLCJqaXp6IiwibGVzYmlhbnNleCIsIm1vdGhlcmZ1Y2tlciIsIm5hemkiLCJuaWdnYSIsIm5pZ2dlciIsInBpc3MiLCJwb3JuIiwicHVzc3kiLCJxdWVlciIsInJhcGUiLCJzaGl0Iiwic2x1dCIsInRpdCIsInRpdHMiLCJ0d2F0Iiwid2FuayIsIndob3JlIiwieHh4Il0=",
    "base64"
  ).toString("utf8")
);

function compactName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function validatePlayerName(name) {
  const cleaned = String(name || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
  if (!cleaned) {
    return { ok: false, name: "", message: "Enter a player name (2+ characters)." };
  }
  if (cleaned.length < 2) {
    return { ok: false, name: cleaned, message: "Name needs at least 2 characters." };
  }
  if (!/^[\p{L}\p{N} .'_-]+$/u.test(cleaned)) {
    return {
      ok: false,
      name: cleaned,
      message: "Use letters, numbers, spaces, . _ ' - only."
    };
  }
  const mashed = compactName(cleaned);
  for (const word of BLOCKED) {
    if (mashed.includes(compactName(word))) {
      return {
        ok: false,
        name: cleaned,
        message: "That name isn't PG enough for this portfolio site. Try another."
      };
    }
  }
  return { ok: true, name: cleaned, message: `Playing as ${cleaned}.` };
}

function normalizePlayerKey(name) {
  const cleaned = String(name || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24)
    .toLowerCase();
  return cleaned || "_guest";
}

function defaultPlayerSettings(playerName = "") {
  return {
    version: 1,
    playerName: playerName || "",
    muted: false,
    difficulty: "normal",
    best: 0,
    updatedAt: null
  };
}

function playersList(store) {
  return Object.entries(store.players || {})
    .filter(([key, p]) => key !== "_guest" && p && p.playerName)
    .map(([key, p]) => ({
      playerName: p.playerName,
      best: Number(p.best || 0),
      updatedAt: p.updatedAt || null,
      key
    }))
    .sort((a, b) => b.best - a.best || String(a.playerName).localeCompare(String(b.playerName)));
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    app: "SnakeArcade",
    node: process.version,
    port: PORT,
    time: new Date().toISOString()
  });
});

app.get("/api/players", (_req, res) => {
  try {
    const store = readStoreUnlocked();
    res.json({
      revision: store.revision,
      players: playersList(store)
    });
  } catch (err) {
    res.status(500).json({ error: "read_failed", message: String(err && err.message) });
  }
});

app.get("/api/settings", (req, res) => {
  const store = readStoreUnlocked();
  const key = normalizePlayerKey(req.query.player);
  const found = store.players[key];
  if (!found) {
    return res.json({
      ...defaultPlayerSettings(key === "_guest" ? "" : String(req.query.player || "").trim()),
      _missing: true,
      revision: store.revision
    });
  }
  return res.json({ ...found, revision: store.revision });
});

app.put("/api/settings", (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const nameCheck = validatePlayerName(body.playerName != null ? body.playerName : "");
  if (!nameCheck.ok) {
    return res.status(400).json({
      ok: false,
      error: "playerName_rejected",
      message: nameCheck.message
    });
  }

  const safeName = nameCheck.name;
  const key = normalizePlayerKey(safeName);
  const force = Boolean(body.force);
  const baseRevision =
    body.baseRevision != null && body.baseRevision !== ""
      ? Number(body.baseRevision)
      : null;

  try {
    const result = withStoreLock(() => {
      const store = readStoreUnlocked();

      if (
        baseRevision != null &&
        Number.isFinite(baseRevision) &&
        Number(store.revision) !== Number(baseRevision)
      ) {
        const err = new Error("revision_conflict");
        err.code = "revision_conflict";
        err.revision = store.revision;
        throw err;
      }

      const previous = store.players[key];
      if (previous && !force) {
        const err = new Error("name_exists");
        err.code = "name_exists";
        err.existing = {
          playerName: previous.playerName,
          best: Number(previous.best || 0),
          updatedAt: previous.updatedAt || null,
          key
        };
        err.revision = store.revision;
        throw err;
      }

      const saved = {
        ...defaultPlayerSettings(safeName),
        ...(previous || {}),
        playerName: safeName,
        muted: Boolean(body.muted),
        difficulty: ["easy", "normal", "fast"].includes(body.difficulty)
          ? body.difficulty
          : (previous && previous.difficulty) || "normal",
        best: Number.isFinite(Number(body.best))
          ? Number(body.best)
          : Number((previous && previous.best) || 0),
        version: 1,
        updatedAt: new Date().toISOString()
      };
      delete saved._missing;
      delete saved.revision;

      store.players[key] = saved;
      store.revision = Number(store.revision || 0) + 1;
      atomicWriteJson(SETTINGS_FILE, store);

      return { player: saved, revision: store.revision };
    });

    return res.json({
      ok: true,
      ...result.player,
      revision: result.revision
    });
  } catch (err) {
    if (err && err.code === "lock_busy") {
      const store = readStoreUnlocked();
      return res.status(409).json({
        error: "lock_busy",
        message: "Settings file is busy. Try again in a moment.",
        revision: store.revision
      });
    }
    if (err && err.code === "revision_conflict") {
      return res.status(409).json({
        error: "revision_conflict",
        message: "Someone else updated the arcade board. Refresh and try again.",
        revision: err.revision
      });
    }
    if (err && err.code === "name_exists") {
      return res.status(409).json({
        error: "name_exists",
        message: "That name is already on the arcade board.",
        existing: err.existing,
        revision: err.revision
      });
    }
    return res.status(500).json({
      error: "write_failed",
      message: String(err && err.message)
    });
  }
});

app.use(express.static(ROOT));

ensureDataStore();

app.listen(PORT, "127.0.0.1", () => {
  console.log(`SnakeArcade listening on http://127.0.0.1:${PORT}`);
});
