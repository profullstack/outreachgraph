-- 0031_video_assets.sql
-- Personalised video as a rendition of an approved draft (PRD §14, §15).
--
-- Renumbered from `0007_video_assets.sql`, which shared its number with
-- `0007_jobs.sql`. `jobs` could not be the one to move — `0008_job_batches`
-- and four later migrations reference it — and nothing anywhere references
-- `video_assets`, so this is the half of the pair that was free to go to the
-- end.
--
-- **Every statement is `IF NOT EXISTS` because of that rename, not by
-- preference.** The `_migrations` ledger is keyed by filename, so to a
-- database that already ran this file under its old name the new name is an
-- unrecorded migration and gets applied a second time. Making that second
-- apply a no-op is what stops the rename from failing on `CREATE TABLE` and
-- taking the container's boot down with it. `0032` then clears the stale
-- ledger row.
--
-- A video row can only exist for a draft, never for a bare recommendation, so
-- the grounding and duplicate-detection work already done on the draft applies
-- to the clip as well. `grounded_signal_ids` is stored again rather than joined
-- because the audit question is "what evidence backed the thing we actually
-- sent", and a later edit to the draft must not rewrite that answer.

CREATE TABLE IF NOT EXISTS video_assets (
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_video_assets_draft ON video_assets(draft_id);
CREATE INDEX IF NOT EXISTS idx_video_assets_workspace ON video_assets(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_assets_status ON video_assets(status) WHERE status IN ('pending', 'rendering');
