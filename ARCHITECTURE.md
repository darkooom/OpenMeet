# OpenMeet architecture

## Overview

| Layer | Choice | Why |
| --- | --- | --- |
| Runtime | One Cloudflare Worker with Static Assets | Single deployable, deploy-button friendly, no cold starts worth mentioning |
| API | Hono 4 | Tiny, Workers-native, typed middleware |
| Database | Cloudflare D1 (SQLite) + Drizzle ORM | Serverless, free tier, transactional batches, triggers |
| Frontend | React 19 + Vite + Tailwind CSS v4, shadcn-style components, Lucide | Fast SPA served from the edge |
| Validation | Zod (shared between server and client) | One source of truth |
| Background work | D1-backed job queue + Cron Trigger (every minute) + `waitUntil` | No paid add-ons, retries & backoff |
| Tests | Vitest (Node + workerd via `@cloudflare/vitest-plugin`), Playwright | Real D1 in tests |

Not used on purpose:

- **Durable Objects** – double-booking protection is enforced inside D1 transactions (see below), so no extra coordination layer is needed. DOs would add complexity and are not required for correctness.
- **Queues** – the D1 job table gives persistence, visibility (admin UI), retries and scheduling (reminders days ahead), which Queues alone do not (max delay 12 h). Cron + `waitUntil` provides near-instant processing.
- **KV** – nothing benefits from eventually-consistent storage; rate limits need atomic counters (D1 UPSERT).

## Request flow

```
request ─► secureHeaders ─► initContext (migrations, host check, base URL)
        ─► loadActor (session cookie | API key) ─► csrf ─► route
```

- `/api/setup/*` – first-run wizard (token protected, atomically locked)
- `/api/auth/*`, `/auth/oauth/*` – accounts, sessions, OAuth (PKCE)
- `/api/public/*` – booking pages, slots, bookings, manage links, routing forms (rate limited)
- `/api/{event-types,schedules,bookings,me,integrations,automation,orgs,insights}` – dashboard (session only)
- `/api/admin/*` – instance administration (super admin)
- `/api/v1/*` – public REST API and agent API (API keys with scopes)
- everything else – the SPA from `dist/client` (`not_found_handling: single-page-application`)

## Data model (main tables)

```
users ─┬─ sessions, oauth_accounts, api_keys
       ├─ schedules ─ availability_rules, date_overrides
       ├─ event_types (personal) ─ private_links
       ├─ calendar_connections ─ calendars
       ├─ workflows ─ workflow_runs, webhooks ─ webhook_deliveries, routing_forms ─ routing_responses
       └─ contacts
organizations ─ memberships, invitations, teams ─ team_members, event_types (team) ─ event_type_hosts
bookings ─ booking_hosts, booking_attendees, reservations, booking_external_events
jobs, email_log, audit_logs, rate_limits, page_views, instance_settings, app_credentials
```

The SQL migrations in `/migrations` are the source of truth (they contain triggers); `src/database/schema.ts` mirrors them for Drizzle and a test verifies both match.

## Booking engine

1. **Slot computation** (`src/server/services/slots.ts`, pure):
   - Weekly rules and date overrides are expanded per local date of the host's schedule time zone and converted to UTC with `zonedToUtc`, which resolves the real offset for each instant (DST gaps/overlaps handled).
   - Candidate starts step through each window (`slotInterval` or duration). A start is valid if `[start − bufferBefore, end + bufferAfter]` does not overlap any busy interval, it respects minimum notice and booking window, and the daily/weekly limits.
   - Modes: `any` (one-on-one, group, round robin) or `all` (collective). Group events re-offer the exact start of an occurrence with free seats.
2. **Busy data** (`availability.ts`): active `reservations` of the hosts + external free/busy (Google, Microsoft, CalDAV, ICS).
3. **Atomic write** (`booking.ts`): a booking writes, in **one D1 batch (= one SQLite transaction)**, the booking, its hosts, one `reservations` row per host (buffered interval) and the attendee.
   - Trigger `reservations_no_overlap_insert` raises `SLOT_UNAVAILABLE` if an active, overlapping reservation of the same user exists. The whole batch rolls back.
   - Trigger `booking_attendees_capacity` raises `CAPACITY_REACHED` when a group occurrence is full.
   - D1 executes writes serially on the database primary, so two concurrent transactions can never both pass the trigger. A plain "SELECT then INSERT" is only used as a fast path for good error messages.
   - Round robin tries the least-booked available host first and falls back to the next host if its reservation fails; collective inserts reservations for all hosts in the same transaction.
   - Rescheduling deactivates the old reservations and inserts new ones in one transaction – on conflict nothing changes.
   - `tests/integration/booking.test.ts` fires 25 parallel requests for one slot (exactly one succeeds) and 8 for a 3-seat group (exactly three succeed). A mutation check (trigger disabled) made 8 of 25 parallel requests succeed – the test detects the race.
4. **Idempotency**: `Idempotency-Key` header → unique `bookings.idempotency_key`; replays return the original booking.

### External calendar race conditions (documented limitation)

External calendars change independently. OpenMeet checks free/busy right before writing a booking, but an event created in Google/Outlook in the following milliseconds cannot be prevented. Mitigations: free/busy is re-checked on every booking (no long-lived cache), errors are surfaced on the connection, and calendar sync failures are retried. Free/busy lookups **fail open** (a provider outage does not block bookings) – the error is shown in the dashboard.

## Jobs

`jobs` rows are claimed with one atomic `UPDATE … WHERE id IN (SELECT … LIMIT n) RETURNING *` (safe with concurrent runners), processed, and marked `done` or rescheduled with exponential backoff + jitter; after `max_attempts` they become `dead` (Administration → Failed jobs, retry button). `dedupe_key` makes enqueueing idempotent. Job types: `booking.event` (fan-out), `email.booking`, `email.raw`, `webhook.deliver`, `workflow.run`, `calendar.sync`.

E-mails are rendered at send time; manage links are decrypted from `booking_attendees.manage_token_enc` so no plaintext tokens sit in the queue. Reminders carry the expected start time and are skipped if the booking moved or was cancelled.

## Migrations

`npm run deploy` runs `wrangler d1 migrations apply DB --remote` (by binding name) and `wrangler deploy`. In addition, the Worker contains a **runtime migrator** that uses Wrangler's own `d1_migrations` table: if a deployment skipped the migration step, the first request applies missing migrations atomically (each migration + its bookkeeping row in one batch). The E2E test boots a completely empty database to prove this path.

## Security architecture

See [SECURITY.md](SECURITY.md).

## Multi-tenancy

Every dashboard/API handler resolves resources through `services/permissions.ts` (`requireEventType`, `requireBooking`, `requireTeam`, `requireOrgRole`). Foreign resources return **404** to avoid ID probing. API keys act as their owner and go through the same checks (no bypass for agents).

## Prepared for an MCP server

The agent API (`/api/v1/agent/*`) exposes exactly the operations an MCP server needs (list event types, availability, book, reschedule, cancel, booking links, agenda) with scoped service tokens and audit logging, and is described in the OpenAPI document. An MCP server can be a thin adapter that maps tools 1:1 onto these endpoints – it is not part of v0.1.
