-- 0051_lead_screening.sql (Postgres). See migrations/0051_lead_screening.sql for the reasoning.
-- A new, empty table and three ADD COLUMNs with constant defaults: no rewrite, no heavy index.

create table if not exists lead_screens (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  findings text NOT NULL DEFAULT '[]',
  screened_at text NOT NULL,
  allowed_at text,
  allowed_by text,
  PRIMARY KEY (workspace_id, person_id)
);

ALTER TABLE contact_import_rejects ADD COLUMN IF NOT EXISTS outcome text NOT NULL DEFAULT 'rejected';
ALTER TABLE contact_imports ADD COLUMN IF NOT EXISTS skipped bigint NOT NULL DEFAULT 0;
ALTER TABLE contact_imports ADD COLUMN IF NOT EXISTS flagged bigint NOT NULL DEFAULT 0;
