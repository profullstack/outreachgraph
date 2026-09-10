-- 0033_avatars_and_reseed.sql
--
-- Two things the digest could not show and one thing the pipeline could not do.
--
-- A face. The digest and the queue list people by name and title, and a name
-- is a poor handle on a stranger. Gravatar already returned a `thumbnailUrl`
-- for every profile it found and the enrichment step threw it away; a search
-- adapter can find the rest. The URL is stored rather than the bytes: it is a
-- pointer to a picture the person published, not a copy of it, and it can be
-- dropped by clearing one column.
--
-- `photo_looked_up_at` is a timestamp for the same reason `contact_enriched_at`
-- is: most lookups miss, and a boolean would make the sweep retry every miss
-- forever. A miss stamps the column; only a hit fills `avatar_url`.
--
-- `reseeded_at` records the last time an active campaign's seed was read
-- again. Every campaign was crawled exactly once, at creation, and a directory
-- that gains members after that day never produced another lead: "sites read
-- 0, new people 0" for ten days straight while six campaigns sat active.

ALTER TABLE people ADD COLUMN avatar_url TEXT;
-- gravatar | search | site — where the picture came from, for the audit trail.
ALTER TABLE people ADD COLUMN avatar_source TEXT;
ALTER TABLE people ADD COLUMN photo_looked_up_at TEXT;

CREATE INDEX IF NOT EXISTS idx_people_photo_lookup
  ON people(photo_looked_up_at) WHERE photo_looked_up_at IS NULL;

ALTER TABLE campaigns ADD COLUMN reseeded_at TEXT;
