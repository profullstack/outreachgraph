-- 0024_contact_imports.sql
--
-- Importing a list you already own, and being able to prove you own it.
--
-- The consent columns are not paperwork. Everything else in this product
-- reaches people it found by crawling, where the lawful basis is legitimate
-- interest and the evidence is the page it came from. An imported list has no
-- such trail: after the spreadsheet is thrown away, nothing distinguishes
-- seventeen thousand people who ticked a box on your own signup form from
-- seventeen thousand addresses bought from a broker. Recording the basis at
-- import time is the only moment that distinction is cheap to capture, and it
-- is the thing a deliverability complaint or a GDPR request actually asks for.
--
-- Rejects are stored rather than counted. "We dropped 900 rows" is not an
-- answer somebody can act on; "these 900, and why" lets them fix the export
-- and re-run it, and lets us be argued with when a rule is wrong.

CREATE TABLE contact_imports (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  campaign_id     TEXT,
  created_by      TEXT,
  filename        TEXT,

  -- What the uploader asserted about how these people were obtained, and
  -- where. Free text on purpose: an enum here would be a guess about
  -- jurisdictions we do not know, and a wrong enum is worse than a sentence.
  consent_basis   TEXT NOT NULL DEFAULT 'opt_in',
  consent_source  TEXT,
  consent_at      TEXT,

  total_rows      INTEGER NOT NULL DEFAULT 0,
  imported        INTEGER NOT NULL DEFAULT 0,
  merged          INTEGER NOT NULL DEFAULT 0,
  rejected        INTEGER NOT NULL DEFAULT 0,

  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'complete', 'failed')),

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_contact_imports_ws ON contact_imports(workspace_id, created_at DESC);

CREATE TABLE contact_import_rejects (
  id           TEXT PRIMARY KEY,
  import_id    TEXT NOT NULL REFERENCES contact_imports(id) ON DELETE CASCADE,
  row_number   INTEGER,
  email        TEXT,
  reason       TEXT NOT NULL,
  detail       TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_contact_import_rejects_import ON contact_import_rejects(import_id, reason);

-- Why this person may be contacted, kept with the person rather than the
-- batch, because the batch is a fact about an afternoon and this is a fact
-- about them. Survives the import row being tidied away.
CREATE TABLE person_consent (
  person_id     TEXT PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL,
  basis         TEXT NOT NULL,
  source        TEXT,
  import_id     TEXT,
  recorded_at   TEXT NOT NULL
);

CREATE INDEX idx_person_consent_ws ON person_consent(workspace_id);

-- The address an imported contact actually gave us.
--
-- Distinct from `email_candidates`, which holds addresses this product
-- *guessed* from a learned domain pattern and which a human then confirms. An
-- imported address is neither guessed nor in need of confirmation: the person
-- typed it into our own form. Storing it as a candidate would put seventeen
-- thousand rows into a review queue that exists to check our own guesswork.
CREATE TABLE person_emails (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  person_id     TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  address       TEXT NOT NULL,
  -- The dots-and-tags-stripped form, so two spellings of one Gmail mailbox
  -- cannot both be imported as separate people.
  dedupe_key    TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'import',
  verified      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

-- One person per mailbox per workspace. This is what makes re-running the same
-- CSV a merge rather than seventeen thousand duplicates, and it is enforced by
-- the index rather than by the importer remembering to check.
CREATE UNIQUE INDEX idx_person_emails_unique ON person_emails(workspace_id, dedupe_key);
CREATE INDEX idx_person_emails_person ON person_emails(person_id);
