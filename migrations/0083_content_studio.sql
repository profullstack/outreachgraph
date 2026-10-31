CREATE TABLE IF NOT EXISTS content_drafts (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  offering_id  TEXT REFERENCES offerings(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('social', 'newsletter', 'article')),
  title        TEXT NOT NULL,
  topic        TEXT NOT NULL,
  audience     TEXT,
  notes        TEXT,
  body         TEXT NOT NULL,
  model        TEXT,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'archived')),
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_content_drafts_workspace
  ON content_drafts(workspace_id, updated_at DESC);
