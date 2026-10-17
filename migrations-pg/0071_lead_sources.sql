-- 0071_lead_sources.sql (Postgres). See migrations/0071_lead_sources.sql for the reasoning.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS lead_source TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS lead_ref TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS lead_rank BIGINT;

CREATE INDEX IF NOT EXISTS idx_companies_lead_source ON companies (lead_source)
  WHERE lead_source IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_companies_updated ON companies (updated_at, id);
CREATE INDEX IF NOT EXISTS idx_companies_name_read ON companies (lower(trim(name)))
  WHERE lead_source IS NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_dedupe_any ON jobs (workspace_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS lead_sources (
  id TEXT PRIMARY KEY,
  enabled BIGINT NOT NULL DEFAULT 1,
  daily_cap BIGINT NOT NULL DEFAULT 0,
  cursor TEXT,
  day TEXT,
  added_today BIGINT NOT NULL DEFAULT 0,
  seen_total BIGINT NOT NULL DEFAULT 0,
  added_total BIGINT NOT NULL DEFAULT 0,
  runs BIGINT NOT NULL DEFAULT 0,
  last_run_at TEXT,
  last_added BIGINT,
  last_error TEXT,
  next_run_at TEXT,
  exhausted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
