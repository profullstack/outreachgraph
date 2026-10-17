-- 0069_offering_demo_url.sql: a short demo video per product.
--
-- A cold email that describes an automation in prose gets the 1-2% reply rate
-- everyone gets. One that says "here is two minutes of it running" lets the
-- reader judge it without a call. The composer appends this link, verbatim,
-- under first-touch emails, and buyer-lead replies may cite it; the model never
-- writes the URL itself, so it cannot be mangled or invented.
ALTER TABLE offerings ADD COLUMN demo_url TEXT;
