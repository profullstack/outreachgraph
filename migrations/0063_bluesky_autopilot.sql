-- 0063_bluesky_autopilot.sql: autopilot may act on Bluesky, per workspace.
--
-- Bluesky follows and replies on trusted-automation campaigns waited for a
-- human in Needs you, about 1,500 of them in one workspace. A workspace that
-- opts in has them carried out by autopilot under a daily cap per kind and a
-- minimum gap between actions, so the connected account never moves faster
-- than a person would. Off by default.
ALTER TABLE workspace_settings ADD COLUMN bluesky_autopilot INTEGER NOT NULL DEFAULT 0;
