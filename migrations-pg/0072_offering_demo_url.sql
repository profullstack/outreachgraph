-- 0072_offering_demo_url.sql (Postgres). See migrations/0072_offering_demo_url.sql for the reasoning.
ALTER TABLE offerings ADD COLUMN IF NOT EXISTS demo_url text;
