-- 0060_community_leads_pending.sql: hold unjudged buyer leads below the floor.
--
-- 0059 shipped scoring posts the model had no budget for by wording alone, and
-- a game "demo" scored 72. Unjudged posts now wait at 45 or less until a scan
-- judges them; this brings the rows written before that change into line.
UPDATE community_leads SET intent = 45 WHERE judged = 0 AND intent > 45;
