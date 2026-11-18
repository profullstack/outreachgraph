-- 0087_crm_calendar (Postgres). See migrations/0087_crm_calendar.sql for the reasoning.

CREATE TABLE IF NOT EXISTS crm_deals (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  contact_name      TEXT,
  contact_email     TEXT,
  company           TEXT,
  person_id         TEXT REFERENCES people(id) ON DELETE SET NULL,
  stage             TEXT NOT NULL DEFAULT 'lead',
  value_cents       BIGINT,
  next_step         TEXT,
  owner_user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  source            TEXT NOT NULL DEFAULT 'manual',
  last_activity_at  TEXT,
  closed_at         TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crm_deals_stage ON crm_deals(workspace_id, stage, updated_at);
CREATE INDEX IF NOT EXISTS idx_crm_deals_email ON crm_deals(workspace_id, contact_email);
CREATE INDEX IF NOT EXISTS idx_crm_deals_person ON crm_deals(person_id);

CREATE TABLE IF NOT EXISTS crm_activities (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  deal_id           TEXT NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,
  body              TEXT NOT NULL,
  occurred_at       TEXT NOT NULL,
  duration_minutes  BIGINT,
  author_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  booking_id        TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crm_activities_deal ON crm_activities(deal_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_crm_activities_ws ON crm_activities(workspace_id, occurred_at);

CREATE TABLE IF NOT EXISTS crm_reminders (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  deal_id           TEXT REFERENCES crm_deals(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  due_at            TEXT NOT NULL,
  done_at           TEXT,
  assignee_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  notified_at       TEXT,
  booking_id        TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crm_reminders_due ON crm_reminders(workspace_id, done_at, due_at);
CREATE INDEX IF NOT EXISTS idx_crm_reminders_notify ON crm_reminders(notified_at, done_at, due_at);

CREATE TABLE IF NOT EXISTS booking_pages (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  handle              TEXT NOT NULL UNIQUE,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  host_name           TEXT NOT NULL DEFAULT '',
  duration_minutes    BIGINT NOT NULL DEFAULT 30,
  timezone            TEXT NOT NULL,
  availability        TEXT NOT NULL,
  buffer_minutes      BIGINT NOT NULL DEFAULT 0,
  min_notice_minutes  BIGINT NOT NULL DEFAULT 240,
  max_days_ahead      BIGINT NOT NULL DEFAULT 30,
  active              BIGINT NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id                 TEXT PRIMARY KEY,
  page_id            TEXT NOT NULL REFERENCES booking_pages(id) ON DELETE CASCADE,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  deal_id            TEXT REFERENCES crm_deals(id) ON DELETE SET NULL,
  starts_at          TEXT NOT NULL,
  ends_at            TEXT NOT NULL,
  guest_name         TEXT NOT NULL,
  guest_email        TEXT NOT NULL,
  guest_note         TEXT,
  guest_timezone     TEXT,
  meeting_url        TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'confirmed',
  manage_token_hash  TEXT NOT NULL,
  reminded_at        TEXT,
  cancelled_at       TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_page ON bookings(page_id, status, starts_at);
CREATE INDEX IF NOT EXISTS idx_bookings_ws ON bookings(workspace_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_bookings_remind ON bookings(status, reminded_at, starts_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_one_per_slot
  ON bookings(page_id, starts_at) WHERE status = 'confirmed';
