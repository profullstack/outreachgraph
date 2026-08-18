-- 0013_cadences.sql
-- A plan over time, instead of one decision at a time.
--
-- `packages/recommend` answers "what is the single best thing to do about this
-- person right now", which is the right question and only half a product. It
-- has no memory of having asked before and no opinion about what should happen
-- on Thursday if nothing happens today, so every prospect got one card and
-- then silence. Following up was a thing a human remembered to do.
--
-- A cadence is the missing axis: an ordered list of steps, each naming a
-- network and an action, each due some hours after the one before it.
--
-- ---------------------------------------------------------------------------
--
-- The reason this is worth building *here* rather than copying a sequencer:
--
-- Every other tool in this category has one execution mode. A step runs, or it
-- is a task someone is nagged about, and the two live in different systems
-- with different reporting — which is why "multichannel" everywhere else means
-- an email sequence plus a to-do list, and why nobody can tell you what the
-- non-email half of a campaign actually did.
--
-- Here the mode of a step is not a property of the step. It is decided by the
-- capability matrix, at execution time, for that (network, action) pair:
--
--   allow / allow_with_approval -> a recommendation the normal machinery runs
--   manual_only                 -> a recommendation a human performs, with the
--                                  prefilled composer already built for them
--   deny                        -> skipped, with the gate that refused it named
--
-- So the same cadence is legal on Bluesky and hand-driven on LinkedIn without
-- being written twice, and if a platform's rules change, the cadences already
-- running change with them at the next step rather than needing a migration.
--
-- Steps deliberately produce `recommendations` rather than executing anything
-- themselves. That row is where approval, the draft, the policy re-check, the
-- rate limits, suppression and the funnel already meet; a second path to the
-- wire would have to re-implement all six and would get one of them wrong.

-- ----------------------------------------------------------------- the plan
CREATE TABLE cadences (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- NULL is a workspace-level template not yet attached to a campaign, which
  -- is how the playbook library ships something a new workspace can enroll
  -- into on day one.
  campaign_id    TEXT REFERENCES campaigns(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  -- draft | active | paused | archived
  status         TEXT NOT NULL DEFAULT 'draft',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX idx_cadences_ws ON cadences(workspace_id, status);
CREATE INDEX idx_cadences_campaign ON cadences(campaign_id);

-- ---------------------------------------------------------------- the steps
--
-- `delay_hours` is measured from the step before it, not from enrollment.
-- Relative offsets are what make a cadence editable: inserting a step between
-- two others shifts everything after it by construction, where absolute
-- offsets would silently keep the old schedule and bunch two touches onto the
-- same afternoon.
CREATE TABLE cadence_steps (
  id             TEXT PRIMARY KEY,
  cadence_id     TEXT NOT NULL REFERENCES cadences(id) ON DELETE CASCADE,
  -- 0-based, contiguous. Enforced in `packages/domain`, not here, so a bad
  -- plan is refused with a sentence rather than a constraint violation.
  position       INTEGER NOT NULL,
  network        TEXT NOT NULL,
  action         TEXT NOT NULL,
  delay_hours    INTEGER NOT NULL DEFAULT 0,
  -- Whether a reply ends the whole cadence here. Default on: continuing to
  -- send a planned sequence at somebody who has answered is the single most
  -- bot-like thing this product could do, and the policy engine's
  -- `conversation_open` gate would refuse it anyway — this stops the enrollment
  -- rather than generating cards that are all refused.
  stop_on_reply  INTEGER NOT NULL DEFAULT 1,
  -- Optional per-step guidance for the composer. Not a template with slots:
  -- the composer still grounds every claim in stored evidence, and this only
  -- says what this touch is *for* ("reference their talk", "ask for a intro").
  intent         TEXT,
  UNIQUE (cadence_id, position)
);

CREATE INDEX idx_cadence_steps_plan ON cadence_steps(cadence_id, position);

-- ---------------------------------------------------------- who is on which
--
-- `next_due_at` is the whole scheduler. The advance job asks for enrollments
-- whose next step is due and does nothing else, so the cost of running it is
-- proportional to the work there is rather than to the number of people
-- enrolled.
CREATE TABLE cadence_enrollments (
  id             TEXT PRIMARY KEY,
  cadence_id     TEXT NOT NULL REFERENCES cadences(id) ON DELETE CASCADE,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id    TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  person_id      TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  -- active | completed | stopped
  status         TEXT NOT NULL DEFAULT 'active',
  -- The next step to run, by position. Equal to the step count when finished.
  current_step   INTEGER NOT NULL DEFAULT 0,
  next_due_at    TEXT,
  stopped_reason TEXT,
  enrolled_at    TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  -- One enrollment per person per cadence. Re-enrolling somebody who is
  -- already partway through would run the opening touch at them a second time.
  UNIQUE (cadence_id, person_id)
);

CREATE INDEX idx_enrollments_due ON cadence_enrollments(workspace_id, status, next_due_at);
CREATE INDEX idx_enrollments_person ON cadence_enrollments(person_id);

-- --------------------------------------------------------- what each step did
--
-- Kept because "the cadence ran" and "the cadence did anything" are different
-- facts, and the gap between them is where this product either earns trust or
-- quietly wastes a lead.
--
-- A step that was skipped names the gate that skipped it, so a campaign whose
-- LinkedIn touches all fell to `manual_only` reads as a plan working as
-- designed rather than as a sequence that silently did nothing.
CREATE TABLE cadence_step_runs (
  id              TEXT PRIMARY KEY,
  enrollment_id   TEXT NOT NULL REFERENCES cadence_enrollments(id) ON DELETE CASCADE,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  step_position   INTEGER NOT NULL,
  network         TEXT NOT NULL,
  action          TEXT NOT NULL,
  -- automated | manual | skipped
  outcome         TEXT NOT NULL,
  -- The policy decision and the gate behind it, for a skipped or manual step.
  policy_decision TEXT,
  policy_gate     TEXT,
  recommendation_id TEXT REFERENCES recommendations(id) ON DELETE SET NULL,
  detail          TEXT,
  occurred_at     TEXT NOT NULL
);

CREATE INDEX idx_step_runs_enrollment ON cadence_step_runs(enrollment_id, step_position);
CREATE INDEX idx_step_runs_ws ON cadence_step_runs(workspace_id, occurred_at DESC);
