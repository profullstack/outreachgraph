-- 0080_pain_phrases_campaign_hubs.sql: search for the complaint, and find the room.
--
-- Pain phrases. "SaaS" or a product category finds people talking about
-- products; "can't find communities" or "nobody sees my posts" finds people who
-- have the problem right now and already want a fix. A monitor carries a list
-- of them beside its keywords; they are searched first, a post that matches one
-- records it in `pain_phrase`, and those leads rank above keyword matches.
--
-- Campaign hubs. On X, Bluesky or LinkedIn there is no subreddit: the audience
-- gathers in the replies under a handful of accounts it follows and answers.
-- `campaign_hubs` keeps the last ranking of those accounts per campaign, read
-- from the leads' public follows and replies, as one JSON document: it is
-- recomputed whole, never edited row by row.
ALTER TABLE lead_monitors ADD COLUMN pain_phrases_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE community_leads ADD COLUMN pain_phrase TEXT;

CREATE TABLE IF NOT EXISTS campaign_hubs (
  campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  result_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaign_hubs_workspace ON campaign_hubs (workspace_id);
