-- 0092_lead_monitors_instant_email: email buyer leads the moment a scan finds them.
--
-- New monitors get it on (set by createLeadMonitor). Existing monitors stay
-- on the daily digest until someone ticks the box, so nobody's inbox changes
-- behaviour under them.

ALTER TABLE lead_monitors ADD COLUMN instant_email INTEGER NOT NULL DEFAULT 0;
