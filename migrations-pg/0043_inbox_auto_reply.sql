-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

alter table interactions add column if not exists subject text;

alter table interactions add column if not exists references_header text;

alter table interactions add column if not exists reply_label text;

alter table interactions add column if not exists reply_confidence double precision;

alter table interactions add column if not exists reply_label_source text;

alter table interactions add column if not exists reply_label_reason text;

alter table interactions add column if not exists labelled_at text;

CREATE INDEX idx_interactions_thread
  ON interactions(workspace_id, person_id, occurred_at);

alter table campaigns add column if not exists auto_reply_mode text NOT NULL DEFAULT 'copilot';

alter table campaigns add column if not exists auto_reply_threshold double precision NOT NULL DEFAULT 0.85;

alter table recommendations add column if not exists reply_to_interaction_id text;

CREATE INDEX idx_recommendations_reply_to
  ON recommendations(reply_to_interaction_id);
