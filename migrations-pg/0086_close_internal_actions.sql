-- 0086_close_internal_actions (Postgres). See migrations/0086_close_internal_actions.sql.
UPDATE actions
   SET status = 'completed', executed_at = COALESCE(executed_at, created_at)
 WHERE status = 'queued' AND kind IN ('refresh_research', 'observe', 'wait');
