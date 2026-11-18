-- 0086_close_internal_actions
-- Internal actions (refresh_research, observe, wait) were written as 'queued' by both approval
-- paths, but nothing ever executes a queued internal action: approving research enqueues the
-- crawl itself, and observe/wait do nothing. They piled up as a fake backlog (1,857 on one
-- campaign by 2026-11-18). Both paths now record them completed; this closes the old ones.
UPDATE actions
   SET status = 'completed', executed_at = COALESCE(executed_at, created_at)
 WHERE status = 'queued' AND kind IN ('refresh_research', 'observe', 'wait');
