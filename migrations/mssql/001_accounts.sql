-- SnakeArcade accounts schema, Microsoft SQL Server dialect (production).
-- Keep in step with migrations/sqlite/001_accounts.sql.
-- Times are epoch milliseconds (BIGINT). *_key columns hold the lowercased
-- email / display name, so uniqueness is case-insensitive whatever the
-- database collation.

CREATE TABLE dbo.users (
  id NVARCHAR(36) NOT NULL CONSTRAINT pk_users PRIMARY KEY,
  email NVARCHAR(254) NOT NULL,
  email_key NVARCHAR(254) NOT NULL,
  password_hash NVARCHAR(255) NOT NULL,
  display_name NVARCHAR(24) NOT NULL,
  display_name_key NVARCHAR(24) NOT NULL,
  email_verified_at BIGINT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT uq_users_email_key UNIQUE (email_key),
  CONSTRAINT uq_users_display_name_key UNIQUE (display_name_key)
);

CREATE TABLE dbo.sessions (
  id_hash CHAR(64) NOT NULL CONSTRAINT pk_sessions PRIMARY KEY,
  user_id NVARCHAR(36) NOT NULL CONSTRAINT fk_sessions_user REFERENCES dbo.users (id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX ix_sessions_user ON dbo.sessions (user_id);
CREATE INDEX ix_sessions_expires ON dbo.sessions (expires_at);

CREATE TABLE dbo.email_tokens (
  token_hash CHAR(64) NOT NULL CONSTRAINT pk_email_tokens PRIMARY KEY,
  user_id NVARCHAR(36) NOT NULL CONSTRAINT fk_email_tokens_user REFERENCES dbo.users (id) ON DELETE CASCADE,
  purpose NVARCHAR(10) NOT NULL CONSTRAINT ck_email_tokens_purpose CHECK (purpose IN (N'verify', N'reset')),
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT NULL
);
CREATE INDEX ix_email_tokens_user ON dbo.email_tokens (user_id, purpose, created_at);

CREATE TABLE dbo.player_scores (
  user_id NVARCHAR(36) NOT NULL CONSTRAINT pk_player_scores PRIMARY KEY
    CONSTRAINT fk_player_scores_user REFERENCES dbo.users (id) ON DELETE CASCADE,
  best INT NOT NULL CONSTRAINT df_player_scores_best DEFAULT 0,
  best_difficulty NVARCHAR(10) NULL,
  score_epoch INT NOT NULL CONSTRAINT df_player_scores_epoch DEFAULT 0,
  updated_at BIGINT NOT NULL
);
CREATE INDEX ix_player_scores_best ON dbo.player_scores (best DESC);

-- Optional: scores from the old name-only board (data/settings.json), filled
-- only by scripts/import-legacy.js. Shown on the board tagged "legacy".
CREATE TABLE dbo.legacy_scores (
  legacy_key NVARCHAR(24) NOT NULL CONSTRAINT pk_legacy_scores PRIMARY KEY,
  player_name NVARCHAR(24) NOT NULL,
  best INT NOT NULL,
  best_difficulty NVARCHAR(10) NULL,
  updated_at BIGINT NULL,
  imported_at BIGINT NOT NULL
);

CREATE TABLE dbo.app_meta (
  meta_key NVARCHAR(50) NOT NULL CONSTRAINT pk_app_meta PRIMARY KEY,
  int_value BIGINT NOT NULL
);
INSERT INTO dbo.app_meta (meta_key, int_value) VALUES (N'board_revision', 0);
