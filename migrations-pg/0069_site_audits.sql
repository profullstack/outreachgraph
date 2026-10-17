-- 0069_site_audits.sql (Postgres). See migrations/0069_site_audits.sql for the reasoning.
CREATE TABLE IF NOT EXISTS site_audits (
  company_id    TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  final_url     TEXT,
  status        TEXT NOT NULL,
  score         INTEGER,
  grade         TEXT,
  http_status   INTEGER,
  summary_json  TEXT,
  fixes_json    TEXT NOT NULL DEFAULT '[]',
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  checked_at    TEXT,
  attempted_at  TEXT,
  next_audit_at TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_site_audits_next ON site_audits(next_audit_at);
CREATE INDEX IF NOT EXISTS idx_site_audits_checked ON site_audits(checked_at);

ALTER TABLE companies ADD COLUMN IF NOT EXISTS refreshed_at text;
