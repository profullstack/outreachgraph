-- 0014_company_identities.sql
-- Keep the social profiles the crawler already finds.
--
-- `extractCompany` in `packages/providers/src/site/extract.ts` has always read
-- outbound profile links, `rel="me"`, and schema.org `sameAs` off a crawled
-- page, and hands them back as `company.identities`. Nothing ever read that
-- field. Every LinkedIn, X, Bluesky, Instagram and YouTube link on every page
-- crawled so far was parsed, classified, and dropped on the floor.
--
-- Production is the proof: across 208 people there are 207 `website`
-- identities, one GitHub and one X — and 64 companies, whose footers between
-- them certainly published more than two profiles. "We want social contact
-- info" was already being collected and thrown away, so this is a table, not
-- a crawler change.
--
-- Company-keyed rather than person-keyed on purpose. A company's `@handle` is
-- not the handle of a person who happens to work there, and writing it onto
-- their row would be exactly the unevidenced merge the PRD forbids: identity
-- precision beats recall, and every claim needs a source. The company page
-- said this profile belongs to the company, so that is what gets stored.

CREATE TABLE company_identities (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  network            TEXT NOT NULL,
  handle             TEXT,
  profile_url        TEXT,
  -- How much the page's own markup vouches for the link. `rel="me"` and
  -- `sameAs` are deliberate machine-readable statements; a bare footer link is
  -- weaker, and the extractor already scores them apart.
  confidence         REAL NOT NULL,
  -- Which page it came from, so a claim can be traced back to the page that
  -- made it rather than to "the crawler said so".
  source_url         TEXT,
  first_seen_at      TEXT NOT NULL,
  last_seen_at       TEXT NOT NULL
);

-- One row per company per profile. A re-crawl refreshes `last_seen_at` instead
-- of appending a duplicate — the same page crawled weekly would otherwise turn
-- one LinkedIn link into fifty-two of them.
CREATE UNIQUE INDEX idx_company_identities_unique
  ON company_identities(company_id, network, handle);

CREATE INDEX idx_company_identities_company
  ON company_identities(company_id);
