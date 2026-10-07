-- 0061_community_leads_rejudge.sql: judge buyer leads again with kind + fit.
--
-- The first judge prompt asked for a number and the model anchored on the
-- floor: an EventLog ad scored 80, a "who wants to be hired" thread 60. The
-- judge now classifies (seeking / problem / discussion / promo / offtopic, and
-- fit) and the score is computed. Rows nobody has acted on go back to the
-- backlog, held below the floor, and the next scans judge them again.
UPDATE community_leads SET intent = 45
 WHERE judged = 1 AND intent > 45 AND status = 'new' AND reply_draft IS NULL AND digested_at IS NULL;
UPDATE community_leads SET judged = 0, reason = NULL
 WHERE judged = 1 AND status = 'new' AND reply_draft IS NULL AND digested_at IS NULL;
