-- 0017_email_candidates.sql
-- Candidate personal addresses, so a prospect can be reached as themselves.
--
-- Production holds 213 people and not one personal address. Every message
-- therefore falls back to the company's shared inbox, which is what put
-- fourteen messages in one `support@` and what the address limits added in
-- 0011 now correctly refuse. The limits are working; there is simply nowhere
-- else to send.
--
-- The obvious fixes do not survive contact with the evidence. `/team`,
-- `/about` and `/contact` were fetched for eight of these companies and every
-- published address was a role mailbox — modern SaaS does not put staff
-- addresses on the marketing site. Scraping commit metadata is worse: the
-- addresses are public, and the platforms publishing them specifically forbid
-- using them for unsolicited mail.
--
-- What is left is to work out the shape a company writes addresses in, from
-- one address already known to be right, and apply it to their colleagues.
-- That makes this table a queue of *claims*, never of facts:
--
--   * `proposed` — derived, and not yet anything. Never sendable. The sender
--     reads `social_identities`, which this table does not write to.
--   * `confirmed` — a human said yes. Confirming also writes the real email
--     identity, and that is the only path from here into an actual send.
--   * `rejected` — a human said no. Kept rather than deleted so the same wrong
--     address is not proposed again next time the stage runs.
--
-- The point of keeping the basis is the learning loop: one confirmation at a
-- domain turns every colleague there from a guess into a derivation, and the
-- operator can see which it was before deciding.

CREATE TABLE email_candidates (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  person_id     TEXT NOT NULL,
  address       TEXT NOT NULL,

  -- Which shape produced it (`first.last`, `flast`, …), and whether that shape
  -- was learned from a confirmed address at this domain or is only the
  -- module's prior about what companies tend to do.
  pattern       TEXT NOT NULL,
  derived       INTEGER NOT NULL DEFAULT 0,
  confidence    REAL NOT NULL,

  status        TEXT NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed', 'confirmed', 'rejected')),

  -- Human-readable account of where the shape came from, shown next to the
  -- address so a reviewer is deciding with the reason in front of them.
  basis         TEXT,

  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  decided_by    TEXT,
  decided_at    TEXT
);

-- One row per address per person: re-running the stage updates a proposal
-- rather than stacking duplicates, and a rejected address stays rejected.
CREATE UNIQUE INDEX idx_email_candidates_unique
  ON email_candidates(workspace_id, person_id, address);

CREATE INDEX idx_email_candidates_queue
  ON email_candidates(workspace_id, status, confidence DESC);

CREATE INDEX idx_email_candidates_person
  ON email_candidates(person_id, status);
