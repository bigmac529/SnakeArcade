"use strict";
// Optional, one-time: copy the old name-only leaderboard (data/settings.json)
// into the database's legacy_scores table. Those rows show on the arcade board
// with a "legacy" tag; they don't belong to any account and can't be claimed.
//
//   npm run import-legacy                      import data/settings.json
//   npm run import-legacy -- --file C:\path\settings.json
//   npm run import-legacy -- --dry-run         show what would be imported
//   npm run import-legacy -- --clear           remove all legacy rows again
//
// Re-running replaces rows with the same key (no duplicates). Players with a
// best of 0 and the anonymous "_guest" entry are skipped. Names that fail
// today's PG filter are skipped too.
const fs = require("fs");
const path = require("path");
const { loadConfig } = require("../src/config");
const { openDatabase } = require("../src/db");
const { pendingMigrations } = require("../src/db/migrate");
const { createStore } = require("../src/store");
const { validateDisplayName, normalizeDifficulty } = require("../src/validation");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readEntries(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const players = parsed && typeof parsed.players === "object" && parsed.players ? parsed.players : {};
  const entries = [];
  const skipped = [];
  for (const [key, p] of Object.entries(players)) {
    const best = Math.floor(Number(p && p.best));
    if (key === "_guest" || !p || !p.playerName || !Number.isFinite(best) || best <= 0) {
      continue;
    }
    const check = validateDisplayName(String(p.playerName));
    if (!check.ok) {
      skipped.push(key);
      continue;
    }
    const updated = Date.parse(p.updatedAt || "");
    entries.push({
      key: String(key).slice(0, 24),
      name: check.name,
      best,
      difficulty: normalizeDifficulty(p.bestDifficulty) || null,
      updatedAt: Number.isFinite(updated) ? updated : Date.now()
    });
  }
  return { entries, skipped };
}

(async () => {
  const config = loadConfig();
  // Only the database settings matter here (no sessions, no email).
  const fatal = config.problems.filter((p) => p.startsWith("DB_"));
  if (fatal.length) {
    fatal.forEach((p) => console.error(p));
    process.exit(1);
  }
  const clear = process.argv.includes("--clear");
  const dryRun = process.argv.includes("--dry-run");
  const file = path.resolve(arg("--file") || config.legacyDataFile);

  let plan = null;
  if (!clear) {
    if (!fs.existsSync(file)) {
      console.error(`No legacy file at ${file}. Nothing to import.`);
      process.exit(1);
    }
    plan = readEntries(file);
    console.log(`${file}: ${plan.entries.length} player(s) with a best above 0 to import${plan.skipped.length ? `, ${plan.skipped.length} skipped (name fails the PG filter)` : ""}.`);
    if (dryRun) {
      plan.entries.forEach((e) => console.log(`  ${e.name}: ${e.best}${e.difficulty ? ` (${e.difficulty})` : ""}`));
      return;
    }
  }

  const db = await openDatabase(config.db);
  try {
    if ((await pendingMigrations(db)).length) {
      console.error("The database has pending migrations. Run `npm run migrate` first.");
      process.exitCode = 1;
      return;
    }
    const store = createStore(db);
    if (clear) {
      await store.clearLegacy();
      console.log("Removed all legacy scores from the board.");
      return;
    }
    const n = await store.importLegacy(plan.entries);
    console.log(`Imported ${n} legacy score(s). They show on the board tagged "legacy".`);
  } finally {
    await db.close();
  }
})().catch((err) => {
  console.error("Import failed:", err && (err.stack || err.message));
  process.exit(1);
});
