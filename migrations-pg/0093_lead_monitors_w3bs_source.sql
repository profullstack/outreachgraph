-- 0093_lead_monitors_w3bs_source.sql (Postgres). See migrations/0093_lead_monitors_w3bs_source.sql for the reasoning.
UPDATE lead_monitors
   SET sources_json = REPLACE(sources_json, '"bluesky"', '"bluesky","w3bs"')
 WHERE sources_json LIKE '%"bluesky"%' AND sources_json NOT LIKE '%"w3bs"%';
