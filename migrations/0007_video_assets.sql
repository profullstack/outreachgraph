-- 0007_video_assets.sql
-- Personalised video as a rendition of an approved draft (PRD §14, §15).
--
-- A video row can only exist for a draft, never for a bare recommendation, so
-- the grounding and duplicate-detection work already done on the draft applies
-- to the clip as well. `grounded_signal_ids` is stored again rather than joined
-- because the audit question is "what evidence backed the thing we actually
-- sent", and a later edit to the draft must not rewrite that answer.

CREATE TABLE video_assets (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  draft_id             TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  recommendation_id    TEXT NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  status               TEXT NOT NULL DEFAULT 'pending',
  -- The spoken script, segment by segment, with its per-segment grounding.
  script_json          TEXT NOT NULL,
  grounded_signal_ids  TEXT NOT NULL DEFAULT '[]',
  asset_url            TEXT,
  duration_seconds     INTEGER,
  -- Which renderer produced it, so a bad batch can be found and re-rendered.
  renderer             TEXT NOT NULL,
  -- Policy version at render time, not at recommendation time. The engine is
  -- re-run before every render, and this records what it decided.
  policy_version       TEXT NOT NULL,
  error                TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

-- One video per draft. Rendering is billable, so a retried pipeline run must
-- not produce a second clip for the same approved message.
CREATE UNIQUE INDEX idx_video_assets_draft ON video_assets(draft_id);
CREATE INDEX idx_video_assets_workspace ON video_assets(workspace_id, created_at DESC);
CREATE INDEX idx_video_assets_status ON video_assets(status) WHERE status IN ('pending', 'rendering');
