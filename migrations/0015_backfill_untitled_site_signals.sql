-- 0015_backfill_untitled_site_signals.sql
-- Give the stalled queue something to act on.
--
-- `storeSiteSignal` used to return early when a crawled person had no job
-- title, so an untitled person got no signal at all. The correlation in
-- production was exact: of 208 people, all 131 with a title had a signal and
-- all 76 without had none — and every one of the 73 cards sitting pending in
-- the approval queue was an untitled person.
--
-- No signal is a dead end by design. `generateRecommendation` refuses to
-- propose an outbound action without a triggering signal (outreach with no
-- reason is the thing the product exists to avoid), so it falls back to
-- `refresh_research` — which, until this change shipped, nothing executed. The
-- card that existed because we had nothing to say could never produce anything
-- to say.
--
-- The code fix stops this recurring. It does not help anyone already crawled,
-- because the signal is deduped on source URL and their crawl already happened
-- and stored nothing. So this writes the row that pass should have written.
--
-- Confidence 0.9 and relevance 0.35 match what the fixed code now stores for
-- an untitled listing. The weight is `decay × confidence × relevance` against
-- a 0.15 floor, so 0.315 fresh and 0.205 at thirty days will trigger, and by
-- sixty days it stops — which is the right shape for "their name is on a
-- page", a thinner pretext than a stated role and one that should go stale
-- sooner.
--
-- `observed_at` is deliberately the person's own `created_at` rather than now:
-- the fact was observed when the page was read, and back-dating it to the
-- truth means the decay curve treats it as the age it really is instead of
-- resetting the clock on evidence nobody re-checked.

INSERT INTO signals (
  id, workspace_id, person_id, network, signal_type, subtype,
  summary, evidence, source_url, source_timestamp, observed_at,
  confidence, relevance, sentiment
)
SELECT
  'sig_bf' || substr(hex(randomblob(10)), 1, 20),
  si.workspace_id,
  p.id,
  'website',
  'content_topic',
  'site_role',
  'Named on the company website' ||
    COALESCE(' (' || co.name || ')', '') || '.',
  -- Evidence is only ever what the page said. An untitled listing has the
  -- name and nothing else, so that is all this claims.
  p.display_name,
  si.profile_url,
  p.created_at,
  p.created_at,
  0.9,
  0.35,
  'neutral'
FROM people p
JOIN (
  -- The website identity that recorded where they were found. `MIN(id)`
  -- rather than any row, so a person named on two pages gets one signal from
  -- a deterministic choice instead of a duplicate per page.
  SELECT person_id, workspace_id, profile_url
    FROM (
      SELECT s.person_id,
             r.workspace_id,
             s.profile_url,
             ROW_NUMBER() OVER (PARTITION BY s.person_id ORDER BY s.id) AS rn
        FROM social_identities s
        JOIN recommendations r ON r.person_id = s.person_id
       WHERE s.network = 'website'
         AND s.profile_url IS NOT NULL
         AND trim(s.profile_url) <> ''
    )
   WHERE rn = 1
) si ON si.person_id = p.id
LEFT JOIN companies co ON co.id = p.current_company_id
WHERE (p.current_title IS NULL OR trim(p.current_title) = '')
  AND p.status NOT IN ('deleted', 'suppressed')
  -- Only people who have none at all. Anyone who already has a signal is
  -- already actionable and must not collect a second, weaker one.
  AND NOT EXISTS (SELECT 1 FROM signals x WHERE x.person_id = p.id);
