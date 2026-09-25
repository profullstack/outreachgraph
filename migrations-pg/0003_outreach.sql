-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

create table recommendations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  person_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  action text NOT NULL,
  network text NOT NULL,
  priority bigint NOT NULL DEFAULT 0,
  reason text NOT NULL,
  trigger_signal_id text REFERENCES signals(id) ON DELETE SET NULL,
  draft_id text,
  policy_status text NOT NULL,
  policy_version text NOT NULL,
  expected_goal text NOT NULL DEFAULT 'start_conversation',
  status text NOT NULL DEFAULT 'pending',
  created_at text NOT NULL,
  expires_at text
);

CREATE INDEX idx_recommendations_queue
  ON recommendations(workspace_id, status, priority DESC);

CREATE INDEX idx_recommendations_person ON recommendations(person_id, created_at DESC);

create table drafts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recommendation_id text NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  subject text,
  body text NOT NULL,
  grounded_signal_ids text NOT NULL DEFAULT '[]',
  checks_json text NOT NULL DEFAULT '[]',
  similarity_hash text,
  model text,
  edited_by_user bigint NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE INDEX idx_drafts_recommendation ON drafts(recommendation_id);

CREATE INDEX idx_drafts_similarity ON drafts(workspace_id, similarity_hash);

create table approvals (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recommendation_id text NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  decision text NOT NULL,
  decided_by text NOT NULL REFERENCES users(id),
  decided_at text NOT NULL,
  note text,
  edited_body text,
  snoozed_until text
);

CREATE INDEX idx_approvals_recommendation ON approvals(recommendation_id);

create table actions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recommendation_id text NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  person_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind text NOT NULL,
  network text NOT NULL,
  mode text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  body text,
  external_url text,
  external_id text,
  error text,
  created_at text NOT NULL,
  executed_at text
);

CREATE INDEX idx_actions_person ON actions(person_id, created_at DESC);

CREATE INDEX idx_actions_rate_limit ON actions(workspace_id, created_at DESC);

create table interactions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  campaign_id text REFERENCES campaigns(id) ON DELETE SET NULL,
  action_id text REFERENCES actions(id) ON DELETE SET NULL,
  network text NOT NULL,
  direction text NOT NULL,
  state text NOT NULL,
  body text,
  occurred_at text NOT NULL,
  recorded_at text NOT NULL
);

CREATE INDEX idx_interactions_person ON interactions(person_id, occurred_at DESC);

CREATE INDEX idx_interactions_ws ON interactions(workspace_id, occurred_at DESC);
