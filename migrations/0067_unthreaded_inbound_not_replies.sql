-- 0067_unthreaded_inbound_not_replies.sql: mail that answers nothing of ours is not a reply.
--
-- Replies were matched on the sender's address alone, and the mailbox read is
-- a real person's inbox. A prospect who is also a vendor writes to it all the
-- time: in production (2026-10-12) the only "reply" in 1,247 sends was twenty
-- Porkbun receipts and renewal notices. The reader now asks for the thread
-- (References naming a Message-ID we sent) or a reply subject; this refiles
-- what the old rule recorded under neither, as `automated`, which no reply
-- count reads. Kept, not deleted: the inbox still shows them.
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
