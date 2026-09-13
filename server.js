const express = require("express");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const PORT = Number(process.env.PORT) || 3023;

const app = express();
app.use(express.json({ limit: "64kb" }));

function ensureDataStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(SETTINGS_FILE)) {
    atomicWriteJson(SETTINGS_FILE, { players: {} });
  }
}

function readStore() {
  ensureDataStore();
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { players: {} };
    }
    if (!parsed.players || typeof parsed.players !== "object") {
      parsed.players = {};
    }
    return parsed;
  } catch (_) {
    return { players: {} };
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

app.get("/api/settings", (req, res) => {
  const store = readStore();
  const key = normalizePlayerKey(req.query.player);
  const found = store.players[key];
  if (!found) {
    return res.json({
      ...defaultPlayerSettings(key === "_guest" ? "" : String(req.query.player || "").trim()),
      _missing: true
    });
  }
  return res.json(found);
});

app.put("/api/settings", (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const key = normalizePlayerKey(body.playerName);
  const store = readStore();
  const previous = store.players[key] || {};
  const saved = {
    ...defaultPlayerSettings(body.playerName || ""),
    ...previous,
    ...body,
    playerName: body.playerName != null ? String(body.playerName).slice(0, 24) : previous.playerName || "",
    muted: Boolean(body.muted),
    difficulty: ["easy", "normal", "fast"].includes(body.difficulty)
      ? body.difficulty
      : previous.difficulty || "normal",
    best: Number.isFinite(Number(body.best)) ? Number(body.best) : Number(previous.best || 0),
    version: 1,
    updatedAt: new Date().toISOString()
  };
  delete saved._missing;
  store.players[key] = saved;
  atomicWriteJson(SETTINGS_FILE, store);
  return res.json(saved);
});

app.use(express.static(ROOT));

ensureDataStore();

app.listen(PORT, () => {
  console.log(`SnakeArcade listening on http://localhost:${PORT}`);
});

