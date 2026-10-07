-- 0061_community_leads_rejudge.sql (Postgres). See migrations/0061_community_leads_rejudge.sql.
update community_leads set intent = 45
 where judged = 1 and intent > 45 and status = 'new' and reply_draft is null and digested_at is null;
update community_leads set judged = 0, reason = null
 where judged = 1 and status = 'new' and reply_draft is null and digested_at is null;
