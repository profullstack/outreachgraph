-- 0067_unthreaded_inbound_not_replies.sql (Postgres). See migrations/0067_unthreaded_inbound_not_replies.sql for the reasoning.
UPDATE interactions
   SET direction = 'automated',
       state = 'auto_replied',
       reply_label = 'other',
       reply_label_source = 'rule',
       reply_label_reason = 'not an answer to anything we sent'
 WHERE network = 'email' AND direction = 'inbound'
   AND NOT (LOWER(COALESCE(subject, '')) LIKE 're:%' OR LOWER(COALESCE(subject, '')) LIKE 're[%'
         OR LOWER(COALESCE(subject, '')) LIKE 'aw:%' OR LOWER(COALESCE(subject, '')) LIKE 'sv:%')
   AND NOT EXISTS (
     SELECT 1 FROM actions a
      WHERE a.workspace_id = interactions.workspace_id AND a.network = 'email'
        AND a.external_id IS NOT NULL
        AND interactions.references_header LIKE '%' || a.external_id || '%');
