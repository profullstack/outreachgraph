-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

CREATE INDEX IF NOT EXISTS idx_workflow_events_person ON workflow_events(person_id);

CREATE INDEX IF NOT EXISTS idx_identity_candidates_person ON identity_candidates(person_id);

CREATE INDEX IF NOT EXISTS idx_rule_runs_person ON rule_runs(person_id);
