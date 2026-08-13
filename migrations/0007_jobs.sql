-- A durable job queue (PRD §1.1 principle 7, "background jobs never run inside
-- a request").
--
-- `JOB_KINDS` has described this table since the first commit; nothing ever
-- created it. Work was either run inline in the request — `POST /prospects`
-- still runs the whole enrich/resolve/research/score/recommend/draft chain
-- before responding — or swept for by the worker loop querying its own domain
-- tables directly. Neither survives a batch: one URL fans out to a fetch, an
-- extraction, an identity search per candidate person and a draft per
-- recommendation, and a hundred URLs is not a slow request but an impossible
-- one.
--
-- Deliberately a table rather than Redis. `REDIS_URL` sits empty in the vault
-- and unreferenced in the code, and Turso is already here, already backed up
-- and already the thing every other durable fact lives in. A queue that can
-- lose its contents on a restart is not a queue.

CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  payload_json  TEXT NOT NULL DEFAULT '{}',
  -- pending | running | done | failed
  status        TEXT NOT NULL DEFAULT 'pending',
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 5,
  -- Not before this instant. Carries both the initial delay and the retry
  -- backoff, so there is one thing to order by rather than two.
  run_after     TEXT NOT NULL,
  last_error    TEXT,
  -- When the current attempt claimed the row. A container that dies mid-job
  -- leaves `running` behind forever without this; the reclaim sweep reads it.
  started_at    TEXT,
  finished_at   TEXT,
  -- Caller-supplied identity for work that must not be queued twice — the same
  -- URL arriving in two of the same bulk paste, say. See the index below.
  dedupe_key    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- The claim query's access path: the oldest runnable job.
CREATE INDEX idx_jobs_runnable ON jobs(status, run_after);

CREATE INDEX idx_jobs_workspace ON jobs(workspace_id, created_at DESC);

-- Uniqueness that expires on its own. The predicate keeps only outstanding
-- work in the index, so re-enqueuing a key whose job already finished is
-- allowed — which is what makes this a "don't queue it twice right now" guard
-- rather than a "never do this again" one.
CREATE UNIQUE INDEX idx_jobs_dedupe
  ON jobs(workspace_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'running');
