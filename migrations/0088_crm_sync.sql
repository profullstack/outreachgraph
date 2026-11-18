-- 0088_crm_sync: the CRM learns from outreach (PRD §39).
--
-- `crm_activities.source_ref` names what an entry was copied from:
-- `int:<interaction id>` for a sent email, a click, a bounce or a reply, and
-- `lse:<lead stage event id>` for a suppression. The partial unique index is
-- what makes the sync idempotent: the same source is written at most once per
-- workspace, so it can re-run every tick and after a crash.

ALTER TABLE crm_activities ADD COLUMN source_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_activities_source
  ON crm_activities(workspace_id, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_deals_ws_person ON crm_deals(workspace_id, person_id);
