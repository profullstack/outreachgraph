-- Batches (PRD §8, URL-first intake).
--
-- Pasting a hundred URLs produces a hundred independent jobs, and the person
-- who pasted them wants one answer: how far along is it, and which ones failed.
-- Without a grouping key the API can only report on jobs it already holds the
-- ids of, which means the client has to remember a hundred of them.
--
-- A column rather than a `batches` table. A batch has no attributes of its own
-- beyond the jobs in it — no name, no owner beyond the workspace already on
-- every job, no lifecycle that is not just the aggregate of its members. A
-- table would add a join and a second thing to keep consistent for nothing.

ALTER TABLE jobs ADD COLUMN batch_id TEXT;

-- The progress query: every job in one batch, oldest first.
CREATE INDEX idx_jobs_batch ON jobs(batch_id, created_at) WHERE batch_id IS NOT NULL;
