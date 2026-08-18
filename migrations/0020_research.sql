-- 0020_research.sql
-- Asking the same question of many prospects, and asking it in their words.
--
-- Two additions, both aimed at the same gap: the product researches one person
-- at a time, in response to one trigger, and has no way to ask a question
-- across a list. "For these two hundred leads, which competitor are they on"
-- is the question a human actually has, and answering it meant opening two
-- hundred cards.
--
-- ---------------------------------------------------------------------------
-- The grid
--
-- N questions across M people, answered into a table. The shape matters more
-- than it looks: a grid is a *batch*, so its cost is knowable before it runs
-- and its progress is visible while it does. A chat box that researches
-- whatever you type has neither property, and model spend is this product's
-- real COGS.
--
-- Answers are grounded the same way drafts are. A cell may only assert what
-- the stored signals for that person support, and "not enough evidence" is a
-- first-class answer rather than a failure — an invented competitor name in a
-- research table is worse than a blank, because nobody double-checks a table.

CREATE TABLE research_grids (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id    TEXT REFERENCES campaigns(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  -- The questions, as a JSON array of {id, prompt}. Stored rather than
  -- normalised because a grid's columns are meaningless outside it and are
  -- never queried across grids.
  questions_json TEXT NOT NULL DEFAULT '[]',
  -- pending | running | complete | failed
  status         TEXT NOT NULL DEFAULT 'pending',
  -- Cells expected and cells answered, so progress is a fraction rather than a
  -- spinner. Written once at creation and incremented as cells land.
  cells_total    INTEGER NOT NULL DEFAULT 0,
  cells_done     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  completed_at   TEXT
);

CREATE INDEX idx_research_grids_ws ON research_grids(workspace_id, created_at DESC);

-- One answer, for one person, to one question.
--
-- `grounded_signal_ids` is what separates this from a guess. It names the
-- evidence the answer rests on, so a surprising cell can be checked without
-- re-running anything, and an empty list next to a confident sentence is a bug
-- a reviewer can see.
CREATE TABLE research_grid_cells (
  id                  TEXT PRIMARY KEY,
  grid_id             TEXT NOT NULL REFERENCES research_grids(id) ON DELETE CASCADE,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id           TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  question_id         TEXT NOT NULL,
  answer              TEXT,
  -- unanswered | answered | no_evidence | failed
  status              TEXT NOT NULL DEFAULT 'unanswered',
  grounded_signal_ids TEXT NOT NULL DEFAULT '[]',
  model               TEXT,
  answered_at         TEXT,
  UNIQUE (grid_id, person_id, question_id)
);

CREATE INDEX idx_grid_cells_grid ON research_grid_cells(grid_id, person_id);
CREATE INDEX idx_grid_cells_pending ON research_grid_cells(grid_id, status);

-- ---------------------------------------------------------------------------
-- Term expansion
--
-- Campaign matching is literal. A campaign listening for "payments provider"
-- does not match "our Stripe fees are killing us", which is the post that
-- actually indicates intent — the prospect who states your category by name is
-- the one already talking to your competitor.
--
-- Expansions are cached per workspace and term rather than computed per crawl.
-- The listening loop runs constantly over the same small set of terms, so
-- expanding on every pass would multiply model spend by the crawl frequency
-- for an answer that changes about as often as the campaign does.
--
-- `source` distinguishes an expansion a model produced from one a human typed,
-- because only the first should ever be silently refreshed.
CREATE TABLE term_expansions (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Lowercased, trimmed. The lookup key, not the display form.
  term           TEXT NOT NULL,
  -- JSON array of related phrases.
  expansions     TEXT NOT NULL DEFAULT '[]',
  -- model | manual
  source         TEXT NOT NULL DEFAULT 'model',
  created_at     TEXT NOT NULL,
  refreshed_at   TEXT NOT NULL,
  UNIQUE (workspace_id, term)
);

CREATE INDEX idx_term_expansions_ws ON term_expansions(workspace_id, term);
