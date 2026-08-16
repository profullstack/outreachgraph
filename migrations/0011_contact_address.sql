-- 0011_contact_address.sql
-- Record the address a message actually went to, not just the person it was for.
--
-- Every rate limit in `packages/policy` is keyed on `person_id`, which is the
-- right key for "how often do we contact this human" and the wrong key for
-- "how much mail does this mailbox get". A prospect with no personal address
-- falls back to their company's shared inbox, so fourteen prospects at one
-- company are fourteen separate people — each comfortably inside its own
-- weekly limit — and one `support@` mailbox receives fourteen messages.
--
-- That is exactly what happened in production: 24 outbound emails reached 6
-- distinct addresses, and `support@canny.io` alone got 14 of them. No
-- person-keyed limit could have seen it, because by its own key nothing was
-- ever contacted twice.
--
-- Storing the resolved address on the interaction makes the mailbox countable.
-- The backfill below reconstructs it for rows written before this migration,
-- using the same resolution order the sender uses, so the limits protect the
-- addresses already contacted rather than starting from a clean slate.

ALTER TABLE interactions ADD COLUMN contact_address TEXT;

-- Whether that address belongs to the person or to their company. A shared
-- inbox is worth naming in a refusal: "weekly limit reached" is baffling for a
-- prospect who has never been contacted, until you know who shares the mailbox.
ALTER TABLE interactions ADD COLUMN shared_inbox INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_interactions_address
  ON interactions(workspace_id, contact_address, occurred_at DESC);

-- Backfill, in the sender's own order of preference: a personal email identity
-- first, the company contact address second. Rows that resolve to neither keep
-- a NULL address and are simply not counted, which is the honest answer — we
-- cannot say where they went.
UPDATE interactions
   SET contact_address = (
         SELECT lower(trim(si.handle))
           FROM social_identities si
          WHERE si.person_id = interactions.person_id
            AND si.network = 'email'
          ORDER BY si.confidence DESC
          LIMIT 1
       )
 WHERE network = 'email'
   AND contact_address IS NULL;

UPDATE interactions
   SET contact_address = (
         SELECT lower(trim(co.contact_email))
           FROM people p
           JOIN companies co ON co.id = p.current_company_id
          WHERE p.id = interactions.person_id
            AND co.contact_email IS NOT NULL
            AND trim(co.contact_email) <> ''
       ),
       shared_inbox = 1
 WHERE network = 'email'
   AND contact_address IS NULL
   -- Only where a company address actually exists, so a row with neither
   -- keeps a NULL address instead of being marked as a shared inbox it has.
   AND EXISTS (
         SELECT 1
           FROM people p
           JOIN companies co ON co.id = p.current_company_id
          WHERE p.id = interactions.person_id
            AND co.contact_email IS NOT NULL
            AND trim(co.contact_email) <> ''
       );
