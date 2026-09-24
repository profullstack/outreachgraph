-- 0042_linkedin_connections_branching.sql
-- Connection requests, and plans that branch on whether they were accepted.
--
-- Until now a cadence was a straight line: every step ran when its time came,
-- and the only thing that could end one early was a reply. That is enough for
-- email and not enough for LinkedIn, where the useful sequence is
--
--   visit their profile -> invite them with a note ->
--     accepted within a week?  message them there
--     not accepted?            email them instead
--
-- and the second half depends on something the person does, not on the clock.
--
-- ---------------------------------------------------------------------------
--
-- The model is deliberately the simplest one that can express that: a step
-- carries an optional *condition*, evaluated at the moment the step falls due.
-- A step whose condition is false is recorded in `cadence_step_runs` as
-- `skipped`, with the condition named, and the enrollment moves on. There is
-- no jump-to-step, no graph, no goto: two sibling steps with opposite
-- conditions are a branch, and a plan remains a list anyone can read top to
-- bottom.
--
-- `wait_for_acceptance_hours`, on a connect step, is the one piece of time the
-- condition needs. A connection-dependent step after it does not decide the
-- moment it comes due if the invitation might still be accepted: it waits,
-- rechecking, until either they accept or the window closes. Without it
-- "if connected" would be evaluated a day after sending the invite and be
-- false for almost everybody.

-- NULL means 'always', which is how every step written before this behaves.
ALTER TABLE cadence_steps ADD COLUMN run_condition TEXT;
ALTER TABLE cadence_steps ADD COLUMN wait_for_acceptance_hours INTEGER;

-- ------------------------------------------------------ who we have invited
--
-- One row per (workspace, person): where the member whose session this
-- workspace connected stands with that person on LinkedIn. Written when an
-- invitation is sent, and whenever a profile lookup learns the answer anyway;
-- read by cadence conditions; advanced by the daily acceptance check.
--
-- Its own table rather than an `interactions` state, because an interaction
-- is an event and this is a state that changes — a pending invite becomes a
-- connection, or quietly lapses — and the acceptance check needs to find
-- "every pending invite not looked at today" without replaying history.
-- The *event* of acceptance is still written to `interactions`
-- (`state = 'connection_accepted'`), so the timeline and rules see it.
CREATE TABLE linkedin_connections (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id        TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  -- The campaign whose card sent the invitation, so an acceptance can fire
  -- campaign-scoped rules. NULL when the state was only observed.
  campaign_id      TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  action_id        TEXT REFERENCES actions(id) ON DELETE SET NULL,
  -- What the session looks the person up by: a profile URL, a vanity name or
  -- an fsd_profile URN.
  profile_ref      TEXT NOT NULL,
  profile_urn      TEXT,
  -- pending | connected | none
  status           TEXT NOT NULL,
  invited_at       TEXT,
  accepted_at      TEXT,
  last_checked_at  TEXT,
  -- When the acceptance check should next look. NULL means it will not: the
  -- person connected, the invitation lapsed, or we stopped asking.
  next_check_at    TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (workspace_id, person_id)
);

CREATE INDEX idx_linkedin_connections_due
  ON linkedin_connections(workspace_id, status, next_check_at);
