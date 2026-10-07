-- 0058_list_sources.sql
--
-- Signal lists from the news (Hunter's planner: newly funded companies, new
-- leadership, conference contacts), found weekly per product by the worker.
--
-- list_source_runs: one row per product, kind and ISO week, the idempotency key.
-- list_source_items: every headline or event page taken, unique per product and
-- URL so a story syndicated across a week is used once, with the company,
-- domain and (for appointments) the person and title it named, and the
-- campaign it was crawled into.

CREATE TABLE IF NOT EXISTS list_source_runs (
  offering_id   TEXT NOT NULL REFERENCES offerings(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  period        TEXT NOT NULL,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  items         INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  ran_at        TEXT NOT NULL,
  PRIMARY KEY (offering_id, kind, period)
);

CREATE TABLE IF NOT EXISTS list_source_items (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  offering_id   TEXT NOT NULL REFERENCES offerings(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  url           TEXT NOT NULL,
  title         TEXT NOT NULL,
  company       TEXT,
  domain        TEXT,
  person        TEXT,
  role          TEXT,
  campaign_id   TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_list_source_items_url ON list_source_items(offering_id, url);
CREATE INDEX IF NOT EXISTS idx_list_source_items_ws ON list_source_items(workspace_id, created_at);
