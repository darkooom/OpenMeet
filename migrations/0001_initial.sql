-- OpenMeet initial schema.
-- All timestamps are INTEGER milliseconds since the Unix epoch (UTC).
-- Statements are separated by "--> statement-breakpoint" so the runtime
-- migrator can split them safely (triggers contain inner semicolons).

CREATE TABLE IF NOT EXISTS instance_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  email_verified_at INTEGER,
  password_hash TEXT,
  name TEXT NOT NULL,
  username TEXT NOT NULL COLLATE NOCASE,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  locale TEXT NOT NULL DEFAULT 'en',
  time_format TEXT NOT NULL DEFAULT '24h',
  bio TEXT,
  avatar_url TEXT,
  brand_color TEXT,
  is_super_admin INTEGER NOT NULL DEFAULT 0,
  disabled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON users(email);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS users_username_uq ON users(username);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS oauth_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  email TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS oauth_accounts_provider_uq ON oauth_accounts(provider, provider_account_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT,
  revoked_at INTEGER
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS verification_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  data TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL COLLATE NOCASE,
  brand_color TEXT,
  logo_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_uq ON organizations(slug);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS memberships (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships(user_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL COLLATE NOCASE,
  description TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS teams_slug_uq ON teams(slug);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('manager','member')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS invitations_token_uq ON invitations(token_hash);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS schedules_user_idx ON schedules(user_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS availability_rules (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_minute INTEGER NOT NULL CHECK (start_minute BETWEEN 0 AND 1440),
  end_minute INTEGER NOT NULL CHECK (end_minute BETWEEN 0 AND 1440),
  CHECK (end_minute > start_minute)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS availability_rules_schedule_idx ON availability_rules(schedule_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS date_overrides (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('available','unavailable')),
  start_minute INTEGER,
  end_minute INTEGER,
  label TEXT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS date_overrides_schedule_idx ON date_overrides(schedule_id, date);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS event_types (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL COLLATE NOCASE,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'one_on_one' CHECK (kind IN ('one_on_one','group','collective','round_robin')),
  duration INTEGER NOT NULL,
  duration_options TEXT NOT NULL DEFAULT '[]',
  color TEXT NOT NULL DEFAULT '#1f7a5c',
  locations TEXT NOT NULL DEFAULT '[]',
  schedule_id TEXT REFERENCES schedules(id) ON DELETE SET NULL,
  slot_interval INTEGER,
  min_notice_minutes INTEGER NOT NULL DEFAULT 120,
  booking_window_days INTEGER NOT NULL DEFAULT 60,
  buffer_before INTEGER NOT NULL DEFAULT 0,
  buffer_after INTEGER NOT NULL DEFAULT 0,
  max_per_day INTEGER,
  max_per_week INTEGER,
  seats INTEGER NOT NULL DEFAULT 1,
  requires_confirmation INTEGER NOT NULL DEFAULT 0,
  is_private INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  questions TEXT NOT NULL DEFAULT '[]',
  redirect_url TEXT,
  confirmation_message TEXT,
  brand_color TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((owner_user_id IS NOT NULL) <> (team_id IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS event_types_owner_slug_uq ON event_types(owner_user_id, slug) WHERE owner_user_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS event_types_team_slug_uq ON event_types(team_id, slug) WHERE team_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS event_type_hosts (
  event_type_id TEXT NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (event_type_id, user_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS private_links (
  id TEXT PRIMARY KEY,
  event_type_id TEXT NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  single_use INTEGER NOT NULL DEFAULT 1,
  used_at INTEGER,
  expires_at INTEGER,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS private_links_token_uq ON private_links(token_hash);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  event_type_id TEXT NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
  organizer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','cancelled','rejected')),
  location_type TEXT,
  location_value TEXT,
  meeting_url TEXT,
  cancel_reason TEXT,
  cancelled_by TEXT,
  rescheduled_from_id TEXT,
  idempotency_key TEXT,
  source TEXT,
  utm TEXT,
  no_show INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  cancelled_at INTEGER,
  CHECK (end_at > start_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS bookings_idempotency_uq ON bookings(idempotency_key) WHERE idempotency_key IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS bookings_organizer_start_idx ON bookings(organizer_user_id, start_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS bookings_event_start_idx ON bookings(event_type_id, start_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS booking_hosts (
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (booking_id, user_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS booking_hosts_user_idx ON booking_hosts(user_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS booking_attendees (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  timezone TEXT NOT NULL,
  locale TEXT,
  answers TEXT NOT NULL DEFAULT '{}',
  manage_token_hash TEXT NOT NULL,
  manage_token_enc TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  no_show INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS booking_attendees_token_uq ON booking_attendees(manage_token_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS booking_attendees_booking_idx ON booking_attendees(booking_id);
--> statement-breakpoint
-- Time reservations per host. The buffered interval of every active booking is
-- stored here. The triggers below make overlapping active reservations for the
-- same user impossible at the database level, independent of application code.
CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  CHECK (end_at > start_at)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS reservations_user_time_idx ON reservations(user_id, active, start_at, end_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS reservations_booking_idx ON reservations(booking_id);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS reservations_no_overlap_insert
BEFORE INSERT ON reservations
WHEN NEW.active = 1
BEGIN
  SELECT RAISE(ABORT, 'SLOT_UNAVAILABLE')
  WHERE EXISTS (
    SELECT 1 FROM reservations r
    WHERE r.user_id = NEW.user_id
      AND r.active = 1
      AND r.booking_id <> NEW.booking_id
      AND r.start_at < NEW.end_at
      AND r.end_at > NEW.start_at
  );
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS reservations_no_overlap_update
BEFORE UPDATE OF active, start_at, end_at, user_id ON reservations
WHEN NEW.active = 1
BEGIN
  SELECT RAISE(ABORT, 'SLOT_UNAVAILABLE')
  WHERE EXISTS (
    SELECT 1 FROM reservations r
    WHERE r.user_id = NEW.user_id
      AND r.active = 1
      AND r.id <> NEW.id
      AND r.booking_id <> NEW.booking_id
      AND r.start_at < NEW.end_at
      AND r.end_at > NEW.start_at
  );
END;
--> statement-breakpoint
-- Group events: the number of active attendees may never exceed the seat count.
CREATE TRIGGER IF NOT EXISTS booking_attendees_capacity
BEFORE INSERT ON booking_attendees
WHEN NEW.status = 'active'
BEGIN
  SELECT RAISE(ABORT, 'CAPACITY_REACHED')
  WHERE (
    SELECT COUNT(*) FROM booking_attendees a
    WHERE a.booking_id = NEW.booking_id AND a.status = 'active'
  ) >= (
    SELECT et.seats FROM bookings b JOIN event_types et ON et.id = b.event_type_id
    WHERE b.id = NEW.booking_id
  );
END;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  bookings_count INTEGER NOT NULL DEFAULT 0,
  last_booked_at INTEGER,
  notes TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS contacts_owner_email_uq ON contacts(owner_user_id, email);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS calendar_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google','microsoft','ics','caldav','zoom')),
  account_email TEXT,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  credentials_enc TEXT,
  expires_at INTEGER,
  scope TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','error','revoked')),
  last_error TEXT,
  last_synced_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS calendar_connections_user_idx ON calendar_connections(user_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS calendars (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  check_conflicts INTEGER NOT NULL DEFAULT 1,
  is_target INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS calendars_conn_ext_uq ON calendars(connection_id, external_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS booking_external_events (
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
  calendar_external_id TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (booking_id, user_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app_credentials (
  provider TEXT PRIMARY KEY,
  data_enc TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  run_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','dead','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 6,
  last_error TEXT,
  dedupe_key TEXT,
  locked_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedupe_uq ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs(status, run_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS email_log (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  booking_id TEXT,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  template TEXT NOT NULL,
  provider TEXT,
  status TEXT NOT NULL CHECK (status IN ('sent','failed','skipped')),
  error TEXT,
  provider_message_id TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_log_created_idx ON email_log(created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('booking.created','booking.confirmed','booking.cancelled','booking.rescheduled','meeting.starting','meeting.completed','booking.no_show')),
  event_type_ids TEXT,
  offset_minutes INTEGER NOT NULL DEFAULT 0,
  steps TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS workflows_owner_idx ON workflows(owner_user_id, trigger);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  booking_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  log TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS workflow_runs_wf_idx ON workflow_runs(workflow_id, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  events TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT REFERENCES webhooks(id) ON DELETE CASCADE,
  workflow_run_id TEXT,
  url TEXT NOT NULL,
  event TEXT NOT NULL,
  status_code INTEGER,
  success INTEGER NOT NULL,
  error TEXT,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS webhook_deliveries_created_idx ON webhook_deliveries(created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS routing_forms (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  fields TEXT NOT NULL DEFAULT '[]',
  rules TEXT NOT NULL DEFAULT '[]',
  fallback TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS routing_responses (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL REFERENCES routing_forms(id) ON DELETE CASCADE,
  answers TEXT NOT NULL,
  target TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user','service')),
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  scopes TEXT NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_uq ON api_keys(key_hash);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user','api_key','system','public')),
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  ip TEXT,
  meta TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS page_views (
  day TEXT NOT NULL,
  event_type_id TEXT NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
  views INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event_type_id)
);
