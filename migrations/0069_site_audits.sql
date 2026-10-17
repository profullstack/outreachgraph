-- 0069_site_audits.sql: the latest seo.rank audit of each company's homepage,
-- and when each company was last re-read.
--
-- One row per company, overwritten by each audit: the question the product
-- asks is "what is wrong with their homepage now", not a history. Scheduling
-- lives on the row too: `next_audit_at` is when the sweep may look again
-- (30 days after a good audit, a week after the site refused, an exponential
-- backoff after a transient error), so the sweep is one indexed range read.
--
-- `companies.refreshed_at` is when a crawl last re-read the company, so the
-- data-refresh sweep can pick the stalest companies without scanning jobs.
CREATE TABLE IF NOT EXISTS site_audits (
  company_id    TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  final_url     TEXT,
  -- ok | failed (the site's answer: unreachable, refused, not HTML) | error (ours, retrying) | dead
  status        TEXT NOT NULL,
  score         INTEGER,
  grade         TEXT,
  http_status   INTEGER,
  summary_json  TEXT,
  fixes_json    TEXT NOT NULL DEFAULT '[]',
  error         TEXT,
  -- Consecutive transient failures; reset by any answer from seo.rank.
  attempts      INTEGER NOT NULL DEFAULT 0,
  checked_at    TEXT,
  attempted_at  TEXT,
  next_audit_at TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_site_audits_next ON site_audits(next_audit_at);
CREATE INDEX IF NOT EXISTS idx_site_audits_checked ON site_audits(checked_at);

ALTER TABLE companies ADD COLUMN refreshed_at TEXT;
