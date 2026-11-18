-- 0089_intro_drafts: Boardy-style introductions turn themselves on (PRD §38).
--
-- `auto_drafted` = 1 while the card's text was written by OutreachGraph from
-- the member's profile and products. The draft sweep may rewrite such a card
-- while it is closed; the member editing any field sets it to 0, and from then
-- on nothing but the member writes it. A drafted card is still closed: only
-- the member's own click opens it, so nobody is shown to other members
-- without having said yes.
--
-- `match_mailed_at` is when the weekly match email last went to this member,
-- and `mail_off` is their opt-out from it.

ALTER TABLE intro_cards ADD COLUMN auto_drafted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE intro_cards ADD COLUMN match_mailed_at TEXT;
ALTER TABLE intro_cards ADD COLUMN mail_off INTEGER NOT NULL DEFAULT 0;
