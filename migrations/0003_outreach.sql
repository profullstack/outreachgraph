-- 0003_outreach.sql
-- Recommendations, drafts, approvals, actions and interactions
-- (PRD §13, §14, §15, §27).

CREATE TABLE recommendations (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id        TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  person_id          TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  action             TEXT NOT NULL,
  network            TEXT NOT NULL,
  priority           INTEGER NOT NULL DEFAULT 0,
  reason             TEXT NOT NULL,
  trigger_signal_id  TEXT REFERENCES signals(id) ON DELETE SET NULL,
  draft_id           TEXT,
  -- Snapshot of the Policy Engine decision at generation time. Re-checked
  -- before execution, because flags and platform rules change (PRD §37).
  policy_status      TEXT NOT NULL,
  policy_version     TEXT NOT NULL,
  expected_goal      TEXT NOT NULL DEFAULT 'start_conversation',
  status             TEXT NOT NULL DEFAULT 'pending',
  created_at         TEXT NOT NULL,
  expires_at         TEXT
);

-- The approval queue: pending work for this workspace, highest priority first.
CREATE INDEX idx_recommendations_queue
  ON recommendations(workspace_id, status, priority DESC);
CREATE INDEX idx_recommendations_person ON recommendations(person_id, created_at DESC);

CREATE TABLE drafts (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recommendation_id    TEXT NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  subject              TEXT,
  body                 TEXT NOT NULL,
  -- Signals whose evidence grounds the personalised claims in `body`.
  grounded_signal_ids  TEXT NOT NULL DEFAULT '[]',
  -- Results of the PRD §14.2 gates; a draft with a failing gate is not shown.
  checks_json          TEXT NOT NULL DEFAULT '[]',
  -- Normalised shingle hash, for cross-prospect duplicate detection (PRD §18).
  similarity_hash      TEXT,
  model                TEXT,
  edited_by_user       INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE INDEX idx_drafts_recommendation ON drafts(recommendation_id);
CREATE INDEX idx_drafts_similarity ON drafts(workspace_id, similarity_hash);

CREATE TABLE approvals (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recommendation_id   TEXT NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  decision            TEXT NOT NULL,
  decided_by          TEXT NOT NULL REFERENCES users(id),
  decided_at          TEXT NOT NULL,
  note                TEXT,
  edited_body         TEXT,
  snoozed_until       TEXT
);

CREATE INDEX idx_approvals_recommendation ON approvals(recommendation_id);

CREATE TABLE actions (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recommendation_id   TEXT NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  person_id           TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL,
  network             TEXT NOT NULL,
  -- official_api | manual | crm (PRD §16.2)
  mode                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'queued',
  body                TEXT,
  external_url        TEXT,
  external_id         TEXT,
  error               TEXT,
  created_at          TEXT NOT NULL,
  executed_at         TEXT
);

CREATE INDEX idx_actions_person ON actions(person_id, created_at DESC);
-- Supports the per-day and per-prospect-per-week rate limits (PRD §7.7, §18).
CREATE INDEX idx_actions_rate_limit ON actions(workspace_id, created_at DESC);

CREATE TABLE interactions (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id      TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  campaign_id    TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  action_id      TEXT REFERENCES actions(id) ON DELETE SET NULL,
  network        TEXT NOT NULL,
  direction      TEXT NOT NULL,
  state          TEXT NOT NULL,
  body           TEXT,
  occurred_at    TEXT NOT NULL,
  recorded_at    TEXT NOT NULL
);

CREATE INDEX idx_interactions_person ON interactions(person_id, occurred_at DESC);
CREATE INDEX idx_interactions_ws ON interactions(workspace_id, occurred_at DESC);
