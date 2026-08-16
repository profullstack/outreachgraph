-- 0012_listening_targets.sql
-- Move listening's targeting off the deployment and onto the campaign.
--
-- Listening shipped configured by `LISTEN_SUBREDDITS` and `LISTEN_RSS_FEEDS`,
-- which are process environment variables. That is the wrong scope by one
-- level: they belong to the container, so every workspace on the deployment
-- necessarily shares one set of subreddits and feeds. A workspace selling job
-- scheduling to plumbers and one selling compliance software to clinics would
-- listen to precisely the same places, and only one of them could be right.
--
-- Worse, it is silent. Nothing errors; the wrong workspace simply receives
-- signals from communities its buyers are not in, which reads as listening
-- working badly rather than as listening pointed somewhere else.
--
-- Where to look is targeting, and targeting already lives on `campaign_filters`
-- next to the keywords it is searched with. These columns put it there.
-- `apps/server` keeps reading the environment, but only as a default for
-- campaigns that have not chosen yet, so a single-tenant deployment behaves as
-- it did before while a multi-tenant one stops cross-wiring.

-- Which feeds this campaign searches: any of reddit, rss, bluesky, nostr.
-- Empty means this campaign does not listen, which stays the default.
ALTER TABLE campaign_filters ADD COLUMN listen_sources TEXT NOT NULL DEFAULT '[]';

-- Where on Reddit. The single highest-leverage setting: an unscoped search for
-- "invoicing" returns mostly noise, while the same word inside three trade
-- subreddits returns people describing the problem they are about to buy a
-- solution for. Empty means site-wide, which is allowed but rarely what anyone
-- wants once they know their communities.
ALTER TABLE campaign_filters ADD COLUMN listen_subreddits TEXT NOT NULL DEFAULT '[]';

-- Feed URLs: trade press, local news, job boards, forum and podcast feeds. A
-- feed has no search of its own, so this list *is* the targeting for RSS.
ALTER TABLE campaign_filters ADD COLUMN listen_feeds TEXT NOT NULL DEFAULT '[]';
