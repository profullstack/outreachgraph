-- 0057_booking_url.sql (Postgres). See migrations/0057_booking_url.sql for the reasoning.
-- One nullable ADD COLUMN, no rewrite.

ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS booking_url text;
