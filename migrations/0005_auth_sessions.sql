-- 0005_auth_sessions.sql
-- Real user authentication (PRD §38 "Account", §34 Security).
--
-- Replaces the shared bearer token as the human authentication path. The token
-- survives only as a machine credential for internal jobs.

-- Sessions are looked up by a SHA-256 hash of the cookie value, never by the
-- value itself: a database leak must not hand an attacker usable sessions.
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  -- The workspace this session is currently acting in. A user may belong to
  -- several; switching rewrites this rather than minting a new session.
  workspace_id  TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  user_agent    TEXT,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

-- Password hashes live on users. `password_hash` already exists from 0000;
-- these columns track the lockout state that makes brute force impractical.
ALTER TABLE users ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TEXT;
ALTER TABLE users ADD COLUMN last_login_at TEXT;
