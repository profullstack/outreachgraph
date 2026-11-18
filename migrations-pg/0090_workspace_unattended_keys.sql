-- 0090_workspace_unattended_keys (Postgres). See migrations/0090_workspace_unattended_keys.sql for the reasoning.

CREATE TABLE IF NOT EXISTS workspace_unattended_keys (
  workspace_id  TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  wrapped_dek   TEXT NOT NULL,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
