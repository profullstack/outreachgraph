-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

create table sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  workspace_id text REFERENCES workspaces(id) ON DELETE SET NULL,
  user_agent text,
  created_at text NOT NULL,
  last_seen_at text NOT NULL,
  expires_at text NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

alter table users add column if not exists failed_login_count bigint NOT NULL DEFAULT 0;

alter table users add column if not exists locked_until text;

alter table users add column if not exists last_login_at text;
