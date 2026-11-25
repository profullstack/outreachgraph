-- 0091_community_leads_alerted: instant buyer-lead alerts (lead.found).
--
-- A lead above its monitor's floor is announced once, as soon as the scan
-- scores it, through the webhook bus (Slack, Zapier, any POST receiver).
-- alerted_at is the once. Leads already stored are marked as announced, so
-- turning this on does not flood a channel with a week of old posts.

ALTER TABLE community_leads ADD COLUMN alerted_at TEXT;
UPDATE community_leads SET alerted_at = created_at WHERE alerted_at IS NULL;
