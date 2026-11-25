-- 0092_lead_monitors_instant_email.sql (Postgres). See migrations/0092_lead_monitors_instant_email.sql for the reasoning.
ALTER TABLE lead_monitors ADD COLUMN IF NOT EXISTS instant_email integer NOT NULL DEFAULT 0;
