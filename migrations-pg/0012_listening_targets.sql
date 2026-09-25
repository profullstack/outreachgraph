-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

alter table campaign_filters add column if not exists listen_sources text NOT NULL DEFAULT '[]';

alter table campaign_filters add column if not exists listen_subreddits text NOT NULL DEFAULT '[]';

alter table campaign_filters add column if not exists listen_feeds text NOT NULL DEFAULT '[]';
