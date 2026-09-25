-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

alter table workspaces add column if not exists auto_approve_internal bigint NOT NULL DEFAULT 1;

INSERT INTO users (id, email, name, status, created_at, updated_at)
SELECT 'usr_auto_approve', 'automation@outreachgraph.invalid',
       'OutreachGraph automation', 'active', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = 'usr_auto_approve');
