-- 0088_crm_sync (Postgres). See migrations/0088_crm_sync.sql for the reasoning.

ALTER TABLE crm_activities ADD COLUMN source_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_activities_source
  ON crm_activities(workspace_id, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_deals_ws_person ON crm_deals(workspace_id, person_id);
