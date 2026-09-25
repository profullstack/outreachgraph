-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

alter table users add column if not exists is_admin bigint NOT NULL DEFAULT 0;

CREATE INDEX idx_users_is_admin ON users(is_admin) WHERE is_admin = 1;
