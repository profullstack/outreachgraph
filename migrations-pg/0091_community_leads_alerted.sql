-- 0091_community_leads_alerted.sql (Postgres). See migrations/0091_community_leads_alerted.sql for the reasoning.
ALTER TABLE community_leads ADD COLUMN IF NOT EXISTS alerted_at text;
UPDATE community_leads SET alerted_at = created_at WHERE alerted_at IS NULL;
