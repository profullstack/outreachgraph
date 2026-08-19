-- 0022_platform_admin.sql
--
-- Platform staff, and the quota exemption that follows from it.
--
-- Note what this is *not*: `organization_members.role` already carries an
-- 'admin' value, but that is a role inside a customer's own organization and
-- every account can mint one. Reusing it to waive quotas would hand every
-- customer an unlimited plan for the price of a role change, so platform staff
-- needs a flag that lives on the user instead.
--
-- Nothing in the API or the UI writes this column. It is set by an operator
-- against the database, which is the point: a privilege the application can
-- grant is a privilege the application can be tricked into granting.

ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

-- Partial index: staff are a handful of rows in a table that is overwhelmingly
-- not staff, and the only query against this column asks which users are
-- admins rather than whether one particular user is.
CREATE INDEX idx_users_is_admin ON users(is_admin) WHERE is_admin = 1;
