-- 0066_campaign_source.sql: every campaign reads a URL of its own, on a schedule.
--
-- Posts were drafted only when someone pasted a link and pressed Draft. A
-- campaign now carries the URL it is about (its product's site unless set),
-- which the worker reads every few hours: each new item of its feed, or a
-- change to the page itself, becomes drafted hand-off cards written in the
-- campaign's voice for its target customer. A person still posts every one.
ALTER TABLE campaigns ADD COLUMN source_url TEXT;
ALTER TABLE campaigns ADD COLUMN post_networks TEXT NOT NULL DEFAULT '["linkedin"]';
ALTER TABLE campaigns ADD COLUMN source_checked_at TEXT;
ALTER TABLE campaigns ADD COLUMN source_fingerprint TEXT;
ALTER TABLE campaigns ADD COLUMN source_error TEXT;

UPDATE campaigns SET source_url = (SELECT url FROM offerings WHERE offerings.id = campaigns.offering_id)
 WHERE source_url IS NULL;

-- What the source has already shown, so only new items are drafted.
CREATE TABLE IF NOT EXISTS campaign_source_items (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  seen_at TEXT NOT NULL,
  drafted_batch_id TEXT,
  PRIMARY KEY (campaign_id, url)
);

ALTER TABLE link_posts ADD COLUMN campaign_id TEXT;
