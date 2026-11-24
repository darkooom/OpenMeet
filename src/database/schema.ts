/**
 * Drizzle table definitions. The SQL in /migrations is the source of truth
 * (it also contains the triggers that enforce booking atomicity); this file
 * mirrors it for typed queries. tests/integration/migrations.test.ts verifies
 * that both stay in sync.
 */
import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

const ts = (name: string) => integer(name);
const bool = (name: string) => integer(name, { mode: "boolean" });

export const instanceSettings = sqliteTable("instance_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  emailVerifiedAt: ts("email_verified_at"),
  passwordHash: text("password_hash"),
  name: text("name").notNull(),
  username: text("username").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  locale: text("locale").notNull().default("en"),
  timeFormat: text("time_format").notNull().default("24h"),
  bio: text("bio"),
  avatarUrl: text("avatar_url"),
  brandColor: text("brand_color"),
  isSuperAdmin: bool("is_super_admin").notNull().default(false),
  disabledAt: ts("disabled_at"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const oauthAccounts = sqliteTable("oauth_accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  email: text("email"),
  createdAt: ts("created_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  createdAt: ts("created_at").notNull(),
  expiresAt: ts("expires_at").notNull(),
  lastSeenAt: ts("last_seen_at").notNull(),
  ip: text("ip"),
  userAgent: text("user_agent"),
  revokedAt: ts("revoked_at"),
});

export const verificationTokens = sqliteTable("verification_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id"),
  purpose: text("purpose").notNull(),
  data: text("data"),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: ts("created_at").notNull(),
});

export const oauthStates = sqliteTable("oauth_states", {
  state: text("state").primaryKey(),
  data: text("data").notNull(),
  expiresAt: ts("expires_at").notNull(),
});

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  brandColor: text("brand_color"),
  logoUrl: text("logo_url"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const memberships = sqliteTable(
  "memberships",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

export const teams = sqliteTable("teams", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description"),
  createdAt: ts("created_at").notNull(),
});

export const teamMembers = sqliteTable(
  "team_members",
  {
    teamId: text("team_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["manager", "member"] }).notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);

export const invitations = sqliteTable("invitations", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  teamId: text("team_id"),
  email: text("email").notNull(),
  role: text("role").notNull(),
  tokenHash: text("token_hash").notNull(),
  invitedBy: text("invited_by"),
  expiresAt: ts("expires_at").notNull(),
  acceptedAt: ts("accepted_at"),
  createdAt: ts("created_at").notNull(),
});

export const schedules = sqliteTable("schedules", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull(),
  isDefault: bool("is_default").notNull().default(false),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const availabilityRules = sqliteTable("availability_rules", {
  id: text("id").primaryKey(),
  scheduleId: text("schedule_id").notNull(),
  weekday: integer("weekday").notNull(),
  startMinute: integer("start_minute").notNull(),
  endMinute: integer("end_minute").notNull(),
});

export const dateOverrides = sqliteTable("date_overrides", {
  id: text("id").primaryKey(),
  scheduleId: text("schedule_id").notNull(),
  date: text("date").notNull(),
  kind: text("kind", { enum: ["available", "unavailable"] }).notNull(),
  startMinute: integer("start_minute"),
  endMinute: integer("end_minute"),
  label: text("label"),
});

export const eventTypes = sqliteTable("event_types", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  teamId: text("team_id"),
  title: text("title").notNull(),
  slug: text("slug").notNull(),
  description: text("description"),
  kind: text("kind", { enum: ["one_on_one", "group", "collective", "round_robin"] }).notNull().default("one_on_one"),
  duration: integer("duration").notNull(),
  durationOptions: text("duration_options").notNull().default("[]"),
  color: text("color").notNull().default("#1f7a5c"),
  locations: text("locations").notNull().default("[]"),
  scheduleId: text("schedule_id"),
  slotInterval: integer("slot_interval"),
  minNoticeMinutes: integer("min_notice_minutes").notNull().default(120),
  bookingWindowDays: integer("booking_window_days").notNull().default(60),
  bufferBefore: integer("buffer_before").notNull().default(0),
  bufferAfter: integer("buffer_after").notNull().default(0),
  maxPerDay: integer("max_per_day"),
  maxPerWeek: integer("max_per_week"),
  seats: integer("seats").notNull().default(1),
  requiresConfirmation: bool("requires_confirmation").notNull().default(false),
  isPrivate: bool("is_private").notNull().default(false),
  isActive: bool("is_active").notNull().default(true),
  questions: text("questions").notNull().default("[]"),
  redirectUrl: text("redirect_url"),
  confirmationMessage: text("confirmation_message"),
  brandColor: text("brand_color"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const eventTypeHosts = sqliteTable(
  "event_type_hosts",
  {
    eventTypeId: text("event_type_id").notNull(),
    userId: text("user_id").notNull(),
    priority: integer("priority").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.eventTypeId, t.userId] })],
);

export const privateLinks = sqliteTable("private_links", {
  id: text("id").primaryKey(),
  eventTypeId: text("event_type_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  singleUse: bool("single_use").notNull().default(true),
  usedAt: ts("used_at"),
  expiresAt: ts("expires_at"),
  createdBy: text("created_by"),
  createdAt: ts("created_at").notNull(),
});

export const bookings = sqliteTable("bookings", {
  id: text("id").primaryKey(),
  eventTypeId: text("event_type_id").notNull(),
  organizerUserId: text("organizer_user_id").notNull(),
  title: text("title").notNull(),
  startAt: ts("start_at").notNull(),
  endAt: ts("end_at").notNull(),
  status: text("status", { enum: ["pending", "confirmed", "cancelled", "rejected"] }).notNull(),
  locationType: text("location_type"),
  locationValue: text("location_value"),
  meetingUrl: text("meeting_url"),
  cancelReason: text("cancel_reason"),
  cancelledBy: text("cancelled_by"),
  rescheduledFromId: text("rescheduled_from_id"),
  idempotencyKey: text("idempotency_key"),
  source: text("source"),
  utm: text("utm"),
  noShow: bool("no_show").notNull().default(false),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
  confirmedAt: ts("confirmed_at"),
  cancelledAt: ts("cancelled_at"),
});

export const bookingHosts = sqliteTable(
  "booking_hosts",
  {
    bookingId: text("booking_id").notNull(),
    userId: text("user_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.bookingId, t.userId] })],
);

export const bookingAttendees = sqliteTable("booking_attendees", {
  id: text("id").primaryKey(),
  bookingId: text("booking_id").notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  timezone: text("timezone").notNull(),
  locale: text("locale"),
  answers: text("answers").notNull().default("{}"),
  manageTokenHash: text("manage_token_hash").notNull(),
  manageTokenEnc: text("manage_token_enc"),
  status: text("status", { enum: ["active", "cancelled"] }).notNull().default("active"),
  noShow: bool("no_show").notNull().default(false),
  createdAt: ts("created_at").notNull(),
});

export const reservations = sqliteTable("reservations", {
  id: text("id").primaryKey(),
  bookingId: text("booking_id").notNull(),
  userId: text("user_id").notNull(),
  startAt: ts("start_at").notNull(),
  endAt: ts("end_at").notNull(),
  active: bool("active").notNull().default(true),
});

export const contacts = sqliteTable("contacts", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  bookingsCount: integer("bookings_count").notNull().default(0),
  lastBookedAt: ts("last_booked_at"),
  notes: text("notes"),
  createdAt: ts("created_at").notNull(),
});

export const calendarConnections = sqliteTable("calendar_connections", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  provider: text("provider", { enum: ["google", "microsoft", "ics", "caldav", "zoom"] }).notNull(),
  accountEmail: text("account_email"),
  accessTokenEnc: text("access_token_enc"),
  refreshTokenEnc: text("refresh_token_enc"),
  credentialsEnc: text("credentials_enc"),
  expiresAt: ts("expires_at"),
  scope: text("scope"),
  status: text("status", { enum: ["active", "error", "revoked"] }).notNull().default("active"),
  lastError: text("last_error"),
  lastSyncedAt: ts("last_synced_at"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const calendars = sqliteTable("calendars", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id").notNull(),
  externalId: text("external_id").notNull(),
  name: text("name").notNull(),
  checkConflicts: bool("check_conflicts").notNull().default(true),
  isTarget: bool("is_target").notNull().default(false),
  isPrimary: bool("is_primary").notNull().default(false),
});

export const bookingExternalEvents = sqliteTable(
  "booking_external_events",
  {
    bookingId: text("booking_id").notNull(),
    userId: text("user_id").notNull(),
    connectionId: text("connection_id").notNull(),
    calendarExternalId: text("calendar_external_id").notNull(),
    externalEventId: text("external_event_id").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.bookingId, t.userId] })],
);

export const appCredentials = sqliteTable("app_credentials", {
  provider: text("provider").primaryKey(),
  dataEnc: text("data_enc").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  payload: text("payload").notNull(),
  runAt: ts("run_at").notNull(),
  status: text("status", { enum: ["pending", "running", "done", "failed", "dead", "cancelled"] }).notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(6),
  lastError: text("last_error"),
  dedupeKey: text("dedupe_key"),
  lockedUntil: ts("locked_until"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const emailLog = sqliteTable("email_log", {
  id: text("id").primaryKey(),
  jobId: text("job_id"),
  bookingId: text("booking_id"),
  toEmail: text("to_email").notNull(),
  subject: text("subject").notNull(),
  template: text("template").notNull(),
  provider: text("provider"),
  status: text("status", { enum: ["sent", "failed", "skipped"] }).notNull(),
  error: text("error"),
  providerMessageId: text("provider_message_id"),
  createdAt: ts("created_at").notNull(),
});

export const workflows = sqliteTable("workflows", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  name: text("name").notNull(),
  trigger: text("trigger").notNull(),
  eventTypeIds: text("event_type_ids"),
  offsetMinutes: integer("offset_minutes").notNull().default(0),
  steps: text("steps").notNull().default("[]"),
  isActive: bool("is_active").notNull().default(true),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const workflowRuns = sqliteTable("workflow_runs", {
  id: text("id").primaryKey(),
  workflowId: text("workflow_id").notNull(),
  bookingId: text("booking_id"),
  status: text("status", { enum: ["running", "succeeded", "failed"] }).notNull(),
  log: text("log").notNull().default("[]"),
  createdAt: ts("created_at").notNull(),
  finishedAt: ts("finished_at"),
});

export const webhooks = sqliteTable("webhooks", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  url: text("url").notNull(),
  secretEnc: text("secret_enc").notNull(),
  events: text("events").notNull(),
  isActive: bool("is_active").notNull().default(true),
  createdAt: ts("created_at").notNull(),
});

export const webhookDeliveries = sqliteTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  webhookId: text("webhook_id"),
  workflowRunId: text("workflow_run_id"),
  url: text("url").notNull(),
  event: text("event").notNull(),
  statusCode: integer("status_code"),
  success: bool("success").notNull(),
  error: text("error"),
  durationMs: integer("duration_ms"),
  createdAt: ts("created_at").notNull(),
});

export const routingForms = sqliteTable("routing_forms", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  fields: text("fields").notNull().default("[]"),
  rules: text("rules").notNull().default("[]"),
  fallback: text("fallback").notNull(),
  isActive: bool("is_active").notNull().default(true),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const routingResponses = sqliteTable("routing_responses", {
  id: text("id").primaryKey(),
  formId: text("form_id").notNull(),
  answers: text("answers").notNull(),
  target: text("target").notNull(),
  createdAt: ts("created_at").notNull(),
});

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["user", "service"] }).notNull().default("user"),
  prefix: text("prefix").notNull(),
  keyHash: text("key_hash").notNull(),
  scopes: text("scopes").notNull(),
  lastUsedAt: ts("last_used_at"),
  expiresAt: ts("expires_at"),
  revokedAt: ts("revoked_at"),
  createdAt: ts("created_at").notNull(),
});

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  actorType: text("actor_type", { enum: ["user", "api_key", "system", "public"] }).notNull(),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  ip: text("ip"),
  meta: text("meta"),
  createdAt: ts("created_at").notNull(),
});

export const rateLimits = sqliteTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: ts("window_start").notNull(),
  count: integer("count").notNull(),
});

export const pageViews = sqliteTable(
  "page_views",
  {
    day: text("day").notNull(),
    eventTypeId: text("event_type_id").notNull(),
    views: integer("views").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.eventTypeId] })],
);

export type User = typeof users.$inferSelect;
export type EventType = typeof eventTypes.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type Schedule = typeof schedules.$inferSelect;
export type CalendarConnection = typeof calendarConnections.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Workflow = typeof workflows.$inferSelect;
