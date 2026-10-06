-- 0051_lead_screening.sql
--
-- Two things an import could not say before: which leads are not worth a
-- message, and what happened to every row that did not become a lead.
--
-- lead_screens holds, per workspace and person, the reasons screening found
-- (a generated name, a relay mailbox, a temp-mail domain, an agent or test
-- account, a role inbox). A row with findings and no allowed_at holds the
-- person back from cold outreach through the policy engine; allowed_at is the
-- human saying "send to them anyway", and it survives a re-import.
--
-- contact_import_rejects grows an outcome so one table is the whole per-row
-- report: 'rejected' (unusable row, as before), 'skipped' (usable, but already
-- in the campaign or project, or suppressed) and 'flagged' (imported, held by
-- screening). The batch keeps a count of each.

CREATE TABLE IF NOT EXISTS lead_screens (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id    TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  findings     TEXT NOT NULL DEFAULT '[]',
  screened_at  TEXT NOT NULL,
  allowed_at   TEXT,
  allowed_by   TEXT,
  PRIMARY KEY (workspace_id, person_id)
);

ALTER TABLE contact_import_rejects ADD COLUMN outcome TEXT NOT NULL DEFAULT 'rejected';
ALTER TABLE contact_imports ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contact_imports ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0;
