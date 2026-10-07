-- 0057_booking_url.sql
--
-- Hunter's planner: answer a positive reply within three hours with a link to
-- book. The workspace's scheduling link (Calendly, Cal.com, SavvyCal...),
-- added to every answer to an `interested` reply. NULL means none: the reply
-- proposes a next step in words instead.

ALTER TABLE workspace_settings ADD COLUMN booking_url TEXT;
