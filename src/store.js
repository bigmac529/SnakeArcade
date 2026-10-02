"use strict";
// Data-access layer: every SQL statement the app runs lives here, always with
// bound @parameters (never string-built values). Works on any adapter from
// src/db (SQLite or SQL Server).
const crypto = require("crypto");

const BOARD_LIMIT = 100;

const num = (v) => (v === null || v === undefined ? null : Number(v));
const iso = (ms) => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());

function limitClause(db, n) {
  return db.dialect === "mssql" ? `OFFSET 0 ROWS FETCH NEXT ${Number(n)} ROWS ONLY` : `LIMIT ${Number(n)}`;
}

function userRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: String(row.id).trim(),
    email: row.email,
    emailKey: row.email_key,
    passwordHash: row.password_hash,
    displayName: row.display_name,
    verified: row.email_verified_at !== null && row.email_verified_at !== undefined,
    best: num(row.best) || 0,
    bestDifficulty: row.best_difficulty || null,
    scoreEpoch: num(row.score_epoch) || 0
  };
}

const USER_COLUMNS = `u.id, u.email, u.email_key, u.password_hash, u.display_name, u.email_verified_at,
  s.best, s.best_difficulty, s.score_epoch`;

class Conflict extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function createStore(db) {
  async function bumpRevision(tx) {
    await tx.run("UPDATE app_meta SET int_value = int_value + 1 WHERE meta_key = @key", { key: "board_revision" });
  }

  async function revision(q = db) {
    const row = await q.get("SELECT int_value FROM app_meta WHERE meta_key = @key", { key: "board_revision" });
    return row ? Number(row.int_value) : 0;
  }

  async function tokenStats(userId, purpose, since, q = db) {
    const row = await q.get(
      "SELECT COUNT(*) AS n, MAX(created_at) AS last_at FROM email_tokens WHERE user_id = @userId AND purpose = @purpose AND created_at > @since",
      { userId, purpose, since }
    );
    return { count: Number((row && row.n) || 0), lastAt: row && row.last_at != null ? Number(row.last_at) : null };
  }

  async function findUserBy(column, value, q = db) {
    const row = await q.get(
      `SELECT ${USER_COLUMNS} FROM users u LEFT JOIN player_scores s ON s.user_id = u.id WHERE u.${column} = @value`,
      { value }
    );
    return userRow(row);
  }

  return {
    Conflict,

    async createUser({ email, emailKey, passwordHash, displayName, displayNameKey, now = Date.now() }) {
      const id = crypto.randomUUID();
      try {
        await db.transaction(async (tx) => {
          if (await tx.get("SELECT id FROM users WHERE email_key = @k", { k: emailKey })) {
            throw new Conflict("email_taken", "An account with this email already exists.");
          }
          if (await tx.get("SELECT id FROM users WHERE display_name_key = @k", { k: displayNameKey })) {
            throw new Conflict("name_taken", "That display name is taken. Try another.");
          }
          await tx.run(
            `INSERT INTO users (id, email, email_key, password_hash, display_name, display_name_key, email_verified_at, created_at, updated_at)
             VALUES (@id, @email, @emailKey, @passwordHash, @displayName, @displayNameKey, NULL, @now, @now)`,
            { id, email, emailKey, passwordHash, displayName, displayNameKey, now }
          );
          await tx.run(
            "INSERT INTO player_scores (user_id, best, best_difficulty, score_epoch, updated_at) VALUES (@id, 0, NULL, 0, @now)",
            { id, now }
          );
        });
      } catch (err) {
        if (err instanceof Conflict) {
          throw err;
        }
        if (db.isUniqueViolation(err)) {
          // Lost a race with a simultaneous signup: say which value clashed.
          const byEmail = await findUserBy("email_key", emailKey);
          throw byEmail
            ? new Conflict("email_taken", "An account with this email already exists.")
            : new Conflict("name_taken", "That display name is taken. Try another.");
        }
        throw err;
      }
      return findUserBy("id", id);
    },

    findUserByEmailKey: (emailKey) => findUserBy("email_key", emailKey),
    findUserById: (id) => findUserBy("id", id),

    async setDisplayName(userId, displayName, displayNameKey, now = Date.now()) {
      try {
        await db.transaction(async (tx) => {
          const clash = await tx.get("SELECT id FROM users WHERE display_name_key = @k AND id <> @id", { k: displayNameKey, id: userId });
          if (clash) {
            throw new Conflict("name_taken", "That display name is taken. Try another.");
          }
          await tx.run("UPDATE users SET display_name = @displayName, display_name_key = @k, updated_at = @now WHERE id = @id", {
            displayName,
            k: displayNameKey,
            now,
            id: userId
          });
          await bumpRevision(tx);
        });
      } catch (err) {
        if (!(err instanceof Conflict) && db.isUniqueViolation(err)) {
          throw new Conflict("name_taken", "That display name is taken. Try another.");
        }
        throw err;
      }
      return findUserBy("id", userId);
    },

    async markVerified(userId, now = Date.now()) {
      await db.transaction(async (tx) => {
        await tx.run("UPDATE users SET email_verified_at = @now, updated_at = @now WHERE id = @id AND email_verified_at IS NULL", { now, id: userId });
        await bumpRevision(tx);
      });
    },

    async setPasswordHash(userId, passwordHash, now = Date.now()) {
      await db.run("UPDATE users SET password_hash = @passwordHash, updated_at = @now WHERE id = @id", { passwordHash, now, id: userId });
    },

    // ---- sessions (only the SHA-256 of the session id is stored)
    async createSession({ idHash, userId, now = Date.now(), expiresAt }) {
      await db.run(
        "INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at) VALUES (@idHash, @userId, @now, @now, @expiresAt)",
        { idHash, userId, now, expiresAt }
      );
    },

    async findSession(idHash, now = Date.now()) {
      const row = await db.get(
        `SELECT ss.last_seen_at, ss.expires_at, ${USER_COLUMNS}
         FROM sessions ss JOIN users u ON u.id = ss.user_id LEFT JOIN player_scores s ON s.user_id = u.id
         WHERE ss.id_hash = @idHash AND ss.expires_at > @now`,
        { idHash, now }
      );
      if (!row) {
        return null;
      }
      return { lastSeenAt: num(row.last_seen_at), expiresAt: num(row.expires_at), user: userRow(row) };
    },

    async touchSession(idHash, now, expiresAt) {
      await db.run("UPDATE sessions SET last_seen_at = @now, expires_at = @expiresAt WHERE id_hash = @idHash", { now, expiresAt, idHash });
    },

    async deleteSession(idHash) {
      await db.run("DELETE FROM sessions WHERE id_hash = @idHash", { idHash });
    },

    async deleteUserSessions(userId) {
      await db.run("DELETE FROM sessions WHERE user_id = @userId", { userId });
    },

    // ---- email tokens (verification / password reset; only hashes stored)
    async createEmailToken({ tokenHash, userId, purpose, now = Date.now(), expiresAt }) {
      await db.run(
        "INSERT INTO email_tokens (token_hash, user_id, purpose, created_at, expires_at, used_at) VALUES (@tokenHash, @userId, @purpose, @now, @expiresAt, NULL)",
        { tokenHash, userId, purpose, now, expiresAt }
      );
    },

    // Look up an open token without using it (reset form validation).
    async peekEmailToken(tokenHash, purpose, now = Date.now()) {
      const row = await db.get(
        "SELECT user_id FROM email_tokens WHERE token_hash = @tokenHash AND purpose = @purpose AND used_at IS NULL AND expires_at > @now",
        { tokenHash, purpose, now }
      );
      return row ? String(row.user_id).trim() : null;
    },

    // Single use: the UPDATE only succeeds once, and only before expiry.
    // Other open tokens of the same purpose for that user are retired too.
    async consumeEmailToken(tokenHash, purpose, now = Date.now()) {
      return db.transaction(async (tx) => {
        const row = await tx.get("SELECT user_id FROM email_tokens WHERE token_hash = @tokenHash AND purpose = @purpose", { tokenHash, purpose });
        if (!row) {
          return null;
        }
        const used = await tx.run(
          "UPDATE email_tokens SET used_at = @now WHERE token_hash = @tokenHash AND purpose = @purpose AND used_at IS NULL AND expires_at > @now",
          { now, tokenHash, purpose }
        );
        if (used.changes !== 1) {
          return null;
        }
        const userId = String(row.user_id).trim();
        await tx.run("UPDATE email_tokens SET used_at = @now WHERE user_id = @userId AND purpose = @purpose AND used_at IS NULL", {
          now,
          userId,
          purpose
        });
        return userId;
      });
    },

    emailTokenStats: (userId, purpose, since) => tokenStats(userId, purpose, since),

    // Rate-limited token creation (resend verification, forgot password).
    // The cooldown / cap check and the INSERT run in ONE transaction that
    // first locks the account's users row, so parallel requests for the same
    // account are serialized and can't all pass the check:
    //   SQLite: BEGIN IMMEDIATE (one writer) + the adapter's single queue;
    //   SQL Server: UPDLOCK, HOLDLOCK on the row, held until commit.
    // Returns { ok: true } or { ok: false, reason: "cooldown" | "cap" |
    // "missing", retryAfterMs }.
    async reserveEmailToken({ tokenHash, userId, purpose, now = Date.now(), expiresAt, windowMs, max, cooldownMs = 0 }) {
      const lockHint = db.dialect === "mssql" ? " WITH (UPDLOCK, HOLDLOCK)" : "";
      return db.transaction(async (tx) => {
        const owner = await tx.get(`SELECT id FROM users${lockHint} WHERE id = @userId`, { userId });
        if (!owner) {
          return { ok: false, reason: "missing", retryAfterMs: 0 };
        }
        const since = now - windowMs;
        const stats = await tokenStats(userId, purpose, since, tx);
        if (cooldownMs > 0 && stats.lastAt !== null && now - stats.lastAt < cooldownMs) {
          return { ok: false, reason: "cooldown", retryAfterMs: cooldownMs - (now - stats.lastAt) };
        }
        if (stats.count >= max) {
          const oldest = await tx.get(
            "SELECT MIN(created_at) AS first_at FROM email_tokens WHERE user_id = @userId AND purpose = @purpose AND created_at > @since",
            { userId, purpose, since }
          );
          const firstAt = oldest && oldest.first_at != null ? Number(oldest.first_at) : now;
          return { ok: false, reason: "cap", retryAfterMs: Math.max(1000, firstAt + windowMs - now) };
        }
        await tx.run(
          "INSERT INTO email_tokens (token_hash, user_id, purpose, created_at, expires_at, used_at) VALUES (@tokenHash, @userId, @purpose, @now, @expiresAt, NULL)",
          { tokenHash, userId, purpose, now, expiresAt }
        );
        return { ok: true };
      });
    },

    // ---- scores
    // Keep the higher, for the current epoch only: ONE conditional UPDATE
    // (higher than the stored best AND the run's epoch is the account's
    // current score_epoch). A single statement is atomic on every engine, so
    // saves can arrive in any order, overlap or repeat without lowering a best,
    // and a save from before a Reset best score (which bumps score_epoch in its
    // own UPDATE of the same row) can never restore the old score, even when
    // both run at the same moment. `epoch` is required (an integer).
    async submitScore(userId, score, difficulty, epoch, now = Date.now()) {
      return db.transaction(async (tx) => {
        const result = await tx.run(
          `UPDATE player_scores SET best = @score, best_difficulty = @difficulty, updated_at = @now
           WHERE user_id = @userId AND best < @score AND score_epoch = @epoch`,
          { score, difficulty, now, userId, epoch }
        );
        if (result.changes === 1) {
          await bumpRevision(tx);
          return { stale: false, improved: true };
        }
        // Nothing written; only say why (the outcome is already decided).
        const current = await tx.get("SELECT score_epoch FROM player_scores WHERE user_id = @userId", { userId });
        if (!current) {
          return { stale: false, improved: false, missing: true };
        }
        return { stale: Number(current.score_epoch) !== epoch, improved: false };
      });
    },

    async resetBest(userId, now = Date.now()) {
      return db.transaction(async (tx) => {
        const current = await tx.get("SELECT best FROM player_scores WHERE user_id = @userId", { userId });
        await tx.run(
          "UPDATE player_scores SET best = 0, best_difficulty = NULL, score_epoch = score_epoch + 1, updated_at = @now WHERE user_id = @userId",
          { now, userId }
        );
        await bumpRevision(tx);
        return { previousBest: current ? Number(current.best) : 0 };
      });
    },

    // Public board: display names only (never emails), verified accounts with
    // a score, plus imported legacy rows if any.
    async board({ viewerId = null } = {}) {
      const rows = await db.all(
        `SELECT u.id, u.display_name, s.best, s.best_difficulty, s.updated_at
         FROM player_scores s JOIN users u ON u.id = s.user_id
         WHERE s.best > 0 AND u.email_verified_at IS NOT NULL
         ORDER BY s.best DESC, u.display_name_key ASC ${limitClause(db, BOARD_LIMIT)}`
      );
      const legacy = await db.all(
        `SELECT player_name, best, best_difficulty, updated_at FROM legacy_scores WHERE best > 0
         ORDER BY best DESC, legacy_key ASC ${limitClause(db, BOARD_LIMIT)}`
      );
      const players = rows.map((r) => {
        const p = { playerName: r.display_name, best: Number(r.best), updatedAt: iso(r.updated_at) };
        if (r.best_difficulty) {
          p.bestDifficulty = r.best_difficulty;
        }
        if (viewerId && String(r.id).trim() === viewerId) {
          p.isYou = true;
        }
        return p;
      });
      for (const r of legacy) {
        const p = { playerName: r.player_name, best: Number(r.best), updatedAt: iso(r.updated_at), legacy: true };
        if (r.best_difficulty) {
          p.bestDifficulty = r.best_difficulty;
        }
        players.push(p);
      }
      players.sort((a, b) => b.best - a.best || (a.legacy ? 1 : 0) - (b.legacy ? 1 : 0) || a.playerName.localeCompare(b.playerName));
      return { revision: await revision(), players: players.slice(0, BOARD_LIMIT) };
    },

    revision,

    async importLegacy(entries, now = Date.now()) {
      let imported = 0;
      await db.transaction(async (tx) => {
        for (const e of entries) {
          await tx.run("DELETE FROM legacy_scores WHERE legacy_key = @key", { key: e.key });
          await tx.run(
            "INSERT INTO legacy_scores (legacy_key, player_name, best, best_difficulty, updated_at, imported_at) VALUES (@key, @name, @best, @difficulty, @updatedAt, @now)",
            { key: e.key, name: e.name, best: e.best, difficulty: e.difficulty, updatedAt: e.updatedAt, now }
          );
          imported += 1;
        }
        await bumpRevision(tx);
      });
      return imported;
    },

    async clearLegacy() {
      await db.transaction(async (tx) => {
        await tx.run("DELETE FROM legacy_scores");
        await bumpRevision(tx);
      });
    },

    // Housekeeping: expired sessions and old tokens.
    async purgeExpired(now = Date.now()) {
      await db.run("DELETE FROM sessions WHERE expires_at <= @now", { now });
      await db.run("DELETE FROM email_tokens WHERE expires_at <= @cutoff", { cutoff: now - 7 * 24 * 3600 * 1000 });
    }
  };
}

module.exports = { createStore, Conflict };
