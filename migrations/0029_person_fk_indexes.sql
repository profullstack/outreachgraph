-- Index the foreign keys that point at `people`.
--
-- SQLite enforces `foreign_keys = 1` here, and enforcement means that deleting
-- one person is a lookup on every child table that references them. Three of
-- those tables had a foreign key to `people` and no index on `person_id`, so
-- each lookup was a full scan.
--
-- `workflow_events` is the one that mattered: 193,195 rows. Removing the
-- 55,940 duplicate people left by the re-crawl defect meant 55,940 scans of it
-- — on the order of ten billion row reads. The delete simply never returned,
-- twice, and looked like write saturation rather than a missing index. With
-- these three indexes the same delete committed in 71 seconds.
--
-- `identity_candidates` and `rule_runs` are empty today and cost nothing to
-- index now; they are here so the next table to fill up does not reproduce
-- this. The indexes are worth keeping regardless of the backfill: person
-- deletion is a standing operation, and privacy requests run it one row at a
-- time against exactly these tables.

CREATE INDEX IF NOT EXISTS idx_workflow_events_person ON workflow_events(person_id);
CREATE INDEX IF NOT EXISTS idx_identity_candidates_person ON identity_candidates(person_id);
CREATE INDEX IF NOT EXISTS idx_rule_runs_person ON rule_runs(person_id);
