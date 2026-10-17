-- 0073_site_audit_issues.sql (Postgres). See migrations/0073_site_audit_issues.sql for the reasoning.
ALTER TABLE site_audits ADD COLUMN IF NOT EXISTS issues INTEGER;

UPDATE site_audits
   SET issues = COALESCE((summary_json::json->>'warn')::int, 0)
              + COALESCE((summary_json::json->>'fail')::int, 0)
 WHERE summary_json IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_site_audits_score ON site_audits(status, score);
