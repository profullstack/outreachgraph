-- 0016_suppress_role_accounts.sql
-- Retire the mailboxes that were stored as people.
--
-- Crawling scrapes names out of prose and markup, and some of what comes back
-- is page furniture rather than a human. Production holds `webmaster` at
-- hithisisbarcelona.com — twice, one of them at identity_confidence 0 — and
-- `admin` at elysiantales.com, each enriched, scored and sitting in the
-- approval queue as a prospect.
--
-- They were harmless only because nothing could act on them: an untitled
-- person had no signal, so the engine could never propose outreach. Migration
-- 0015 removed exactly that accident of protection. Without this, the next
-- regeneration pass would hand a reviewer a card proposing an email to
-- somebody called "webmaster", and autopilot would eventually send it.
--
-- `isLikelyRoleAccount` now rejects these at the pipeline's single choke point
-- so no new ones are created. This is for the ones already stored.
--
-- Suppressed rather than deleted, deliberately. Suppression is the mechanism
-- the product already has for "never contact this record", it survives a later
-- provider lookup re-ingesting the same name, and it keeps the audit trail
-- that explains why a lead disappeared. Deleting would lose both.

-- The same shortlist the code guard uses, kept to the cases actually observed
-- plus the obvious mailbox words. Whole-string matches only: `Admin` goes,
-- `Admina Kovač` stays.
UPDATE people
   SET status = 'suppressed',
       outreach_eligible = 0,
       updated_at = datetime('now')
 WHERE status = 'active'
   AND lower(trim(display_name)) IN (
     'webmaster', 'admin', 'administrator', 'postmaster', 'hostmaster',
     'support', 'info', 'information', 'contact', 'contact us', 'sales',
     'hello', 'team', 'staff', 'office', 'help', 'helpdesk',
     'enquiries', 'inquiries', 'marketing', 'press', 'media',
     'careers', 'jobs', 'recruiting', 'billing', 'accounts', 'accounting',
     'legal', 'privacy', 'security', 'abuse', 'noreply', 'no-reply',
     'donotreply', 'newsletter', 'subscribe', 'unsubscribe',
     'user', 'guest', 'customer', 'customer service', 'anonymous',
     'unknown', 'null', 'undefined', 'none', 'test', 'bot', 'moderator'
   );

-- Their queued work goes with them. A suppressed person must not leave a
-- pending card behind: the queue is read by status, so a card left `pending`
-- would still be shown, still be approvable, and still reach the send path.
UPDATE recommendations
   SET status = 'cancelled'
 WHERE status = 'pending'
   AND person_id IN (SELECT id FROM people WHERE status = 'suppressed');
