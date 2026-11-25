-- 0093_lead_monitors_w3bs_source: social.w3bs.org joins the buyer-lead sources.
--
-- social.w3bs.org is a Bluesky PDS, so a monitor that already listens on
-- Bluesky gets it too. Monitors with Bluesky off stay as they are.

UPDATE lead_monitors
   SET sources_json = REPLACE(sources_json, '"bluesky"', '"bluesky","w3bs"')
 WHERE sources_json LIKE '%"bluesky"%' AND sources_json NOT LIKE '%"w3bs"%';
