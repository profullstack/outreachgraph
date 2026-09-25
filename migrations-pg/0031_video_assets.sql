-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

create table if not exists video_assets (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  draft_id text NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  recommendation_id text NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  script_json text NOT NULL,
  grounded_signal_ids text NOT NULL DEFAULT '[]',
  asset_url text,
  duration_seconds bigint,
  renderer text NOT NULL,
  policy_version text NOT NULL,
  error text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_video_assets_draft ON video_assets(draft_id);

CREATE INDEX IF NOT EXISTS idx_video_assets_workspace ON video_assets(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_video_assets_status ON video_assets(status) WHERE status IN ('pending', 'rendering');
