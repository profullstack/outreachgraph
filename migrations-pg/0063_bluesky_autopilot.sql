-- 0063_bluesky_autopilot.sql (Postgres). See migrations/0063_bluesky_autopilot.sql for the reasoning.
ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS bluesky_autopilot BIGINT NOT NULL DEFAULT 0;
