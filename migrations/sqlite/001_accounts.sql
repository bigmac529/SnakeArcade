-- SnakeArcade accounts schema, SQLite dialect (local development and tests).
-- Keep in step with migrations/mssql/001_accounts.sql.
-- Times are epoch milliseconds (INTEGER). *_key columns hold the lowercased
-- email / display name, so uniqueness is case-insensitive on every engine.

CREATE TABLE users (
  id TEXT NOT NULL PRIMARY KEY,
  email TEXT NOT NULL,
  email_key TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  display_name_key TEXT NOT NULL,
  email_verified_at INTEGER NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT uq_users_email_key UNIQUE (email_key),
  CONSTRAINT uq_users_display_name_key UNIQUE (display_name_key)
);

CREATE TABLE sessions (
  id_hash TEXT NOT NULL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX ix_sessions_user ON sessions (user_id);
CREATE INDEX ix_sessions_expires ON sessions (expires_at);

CREATE TABLE email_tokens (
  token_hash TEXT NOT NULL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER NULL
);
CREATE INDEX ix_email_tokens_user ON email_tokens (user_id, purpose, created_at);

CREATE TABLE player_scores (
  user_id TEXT NOT NULL PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  best INTEGER NOT NULL DEFAULT 0,
  best_difficulty TEXT NULL,
  score_epoch INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX ix_player_scores_best ON player_scores (best DESC);

-- Optional: scores from the old name-only board (data/settings.json), filled
-- only by scripts/import-legacy.js. Shown on the board tagged "legacy".
CREATE TABLE legacy_scores (
  legacy_key TEXT NOT NULL PRIMARY KEY,
  player_name TEXT NOT NULL,
  best INTEGER NOT NULL,
  best_difficulty TEXT NULL,
  updated_at INTEGER NULL,
  imported_at INTEGER NOT NULL
);

CREATE TABLE app_meta (
  meta_key TEXT NOT NULL PRIMARY KEY,
  int_value INTEGER NOT NULL
);
INSERT INTO app_meta (meta_key, int_value) VALUES ('board_revision', 0);
