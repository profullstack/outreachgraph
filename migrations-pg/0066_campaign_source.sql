-- 0066_campaign_source.sql (Postgres). See migrations/0066_campaign_source.sql for the reasoning.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS post_networks TEXT NOT NULL DEFAULT '["linkedin"]';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS source_checked_at TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS source_fingerprint TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS source_error TEXT;

UPDATE campaigns SET source_url = (SELECT url FROM offerings WHERE offerings.id = campaigns.offering_id)
 WHERE source_url IS NULL;

CREATE TABLE IF NOT EXISTS campaign_source_items (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  seen_at TEXT NOT NULL,
  drafted_batch_id TEXT,
  PRIMARY KEY (campaign_id, url)
);

ALTER TABLE link_posts ADD COLUMN IF NOT EXISTS campaign_id TEXT;
