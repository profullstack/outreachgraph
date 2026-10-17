-- 0073_site_audit_issues.sql: how much each audited homepage has to fix.
--
-- Picking imported companies for a paid crawl now prefers weak SEO (score
-- under 70) with the most to fix, so the count (warnings plus failures) is a
-- column the pick can order by rather than JSON it has to parse.
ALTER TABLE site_audits ADD COLUMN issues INTEGER;

UPDATE site_audits
   SET issues = COALESCE(json_extract(summary_json, '$.warn'), 0)
              + COALESCE(json_extract(summary_json, '$.fail'), 0)
 WHERE summary_json IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_site_audits_score ON site_audits(status, score);
