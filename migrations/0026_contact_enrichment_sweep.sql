-- 0026_contact_enrichment_sweep.sql
--
-- Enrichment as a swept set rather than seventeen thousand queue rows.
--
-- `POST /contacts/imports/:id/finish` enqueued one `enrich_contact` job per
-- imported person. For a list of seventeen thousand that is seventeen thousand
-- inserts inside one HTTP request, which does not return — and if it did, the
-- worker drains twenty-five jobs a tick, so the queue behind it would take
-- eleven hours while every crawl waited its turn behind it.
--
-- The set of people needing enrichment is derivable: it is everyone with an
-- imported address we have not looked up yet. Deriving it costs one indexed
-- query per tick instead of a row per person, cannot drift from reality, and
-- resumes by itself after a crash — the same argument `metering.ts` makes for
-- computing usage rather than incrementing it.
--
-- A timestamp rather than a boolean because "never tried" and "tried and found
-- nothing" must be distinguishable: most addresses have no published profile,
-- and a boolean would make the sweep retry every one of them forever.

ALTER TABLE people ADD COLUMN contact_enriched_at TEXT;

-- The sweep's only query: imported people, not yet looked up, oldest first.
CREATE INDEX idx_people_contact_enrichment
  ON people(contact_enriched_at) WHERE contact_enriched_at IS NULL;
