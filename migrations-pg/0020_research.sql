-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

create table research_grids (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id text REFERENCES campaigns(id) ON DELETE CASCADE,
  name text NOT NULL,
  questions_json text NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'pending',
  cells_total bigint NOT NULL DEFAULT 0,
  cells_done bigint NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  completed_at text
);

CREATE INDEX idx_research_grids_ws ON research_grids(workspace_id, created_at DESC);

create table research_grid_cells (
  id text PRIMARY KEY,
  grid_id text NOT NULL REFERENCES research_grids(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  question_id text NOT NULL,
  answer text,
  status text NOT NULL DEFAULT 'unanswered',
  grounded_signal_ids text NOT NULL DEFAULT '[]',
  model text,
  answered_at text,
  UNIQUE (grid_id, person_id, question_id)
);

CREATE INDEX idx_grid_cells_grid ON research_grid_cells(grid_id, person_id);

CREATE INDEX idx_grid_cells_pending ON research_grid_cells(grid_id, status);

create table term_expansions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  term text NOT NULL,
  expansions text NOT NULL DEFAULT '[]',
  source text NOT NULL DEFAULT 'model',
  created_at text NOT NULL,
  refreshed_at text NOT NULL,
  UNIQUE (workspace_id, term)
);

CREATE INDEX idx_term_expansions_ws ON term_expansions(workspace_id, term);
