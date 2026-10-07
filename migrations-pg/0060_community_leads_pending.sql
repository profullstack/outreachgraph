-- 0060_community_leads_pending.sql (Postgres). See migrations/0060_community_leads_pending.sql.
update community_leads set intent = 45 where judged = 0 and intent > 45;
