-- 0080_pain_phrases_campaign_hubs.sql (Postgres). See migrations/0080_pain_phrases_campaign_hubs.sql for the reasoning.
ALTER TABLE lead_monitors ADD COLUMN IF NOT EXISTS pain_phrases_json text NOT NULL DEFAULT '[]';
ALTER TABLE community_leads ADD COLUMN IF NOT EXISTS pain_phrase text;

CREATE TABLE IF NOT EXISTS campaign_hubs (
  campaign_id text PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  computed_at text NOT NULL,
  result_json text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaign_hubs_workspace ON campaign_hubs (workspace_id);
