-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

create table cadences (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id text REFERENCES campaigns(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE INDEX idx_cadences_ws ON cadences(workspace_id, status);

CREATE INDEX idx_cadences_campaign ON cadences(campaign_id);

create table cadence_steps (
  id text PRIMARY KEY,
  cadence_id text NOT NULL REFERENCES cadences(id) ON DELETE CASCADE,
  position bigint NOT NULL,
  network text NOT NULL,
  action text NOT NULL,
  delay_hours bigint NOT NULL DEFAULT 0,
  stop_on_reply bigint NOT NULL DEFAULT 1,
  intent text,
  UNIQUE (cadence_id, position)
);

CREATE INDEX idx_cadence_steps_plan ON cadence_steps(cadence_id, position);

create table cadence_enrollments (
  id text PRIMARY KEY,
  cadence_id text NOT NULL REFERENCES cadences(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  person_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active',
  current_step bigint NOT NULL DEFAULT 0,
  next_due_at text,
  stopped_reason text,
  enrolled_at text NOT NULL,
  updated_at text NOT NULL,
  UNIQUE (cadence_id, person_id)
);

CREATE INDEX idx_enrollments_due ON cadence_enrollments(workspace_id, status, next_due_at);

CREATE INDEX idx_enrollments_person ON cadence_enrollments(person_id);

create table cadence_step_runs (
  id text PRIMARY KEY,
  enrollment_id text NOT NULL REFERENCES cadence_enrollments(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  step_position bigint NOT NULL,
  network text NOT NULL,
  action text NOT NULL,
  outcome text NOT NULL,
  policy_decision text,
  policy_gate text,
  recommendation_id text REFERENCES recommendations(id) ON DELETE SET NULL,
  detail text,
  occurred_at text NOT NULL
);

CREATE INDEX idx_step_runs_enrollment ON cadence_step_runs(enrollment_id, step_position);

CREATE INDEX idx_step_runs_ws ON cadence_step_runs(workspace_id, occurred_at DESC);
