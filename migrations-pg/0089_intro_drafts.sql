-- 0089_intro_drafts (Postgres). See migrations/0089_intro_drafts.sql for the reasoning.

ALTER TABLE intro_cards ADD COLUMN auto_drafted BIGINT NOT NULL DEFAULT 0;
ALTER TABLE intro_cards ADD COLUMN match_mailed_at TEXT;
ALTER TABLE intro_cards ADD COLUMN mail_off BIGINT NOT NULL DEFAULT 0;
