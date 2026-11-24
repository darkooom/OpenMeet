# OpenMeet – implementation plan

Goal: a production-usable, self-hostable, Cloudflare-native scheduling platform (Calendly/Cal.com alternative) that installs with one click.

Principle: a working, deployable MVP first; every phase leaves the app buildable and tested. Unfinished items are marked in [PROGRESS.md](PROGRESS.md).

## Phase 1 – Foundation ✅
- Repository, TypeScript strict, ESLint, Vitest (Node + workerd), Playwright
- Single Worker (Hono) + Static Assets, `wrangler.jsonc` with auto-provisioned D1 and cron trigger
- D1 schema + migrations (Wrangler + runtime migrator), Drizzle schema with sync test
- Auth: registration policy, login/logout, sessions, e-mail verification, password reset, Google/Microsoft OAuth (PKCE)
- First-run setup wizard protected by `SETUP_TOKEN`, atomically locked
- Deploy button configuration and deploy script

## Phase 2 – Functional MVP ✅
- Dashboard with real data
- Event types (all options), availability schedules with overrides
- Slot engine (time zones, DST, buffers, limits), atomic booking engine, idempotency
- Public booking pages (user, team, private link), confirmation, manage links (reschedule/cancel), ICS export

## Phase 3 – Integrations ✅ (live provider verification pending)
- Calendar adapters: Google, Microsoft, CalDAV, ICS feed; token refresh; event sync; meeting links (Meet, Teams, Zoom, Jitsi)
- Notifications: Resend/Brevo/Postmark, templates (en/de), reminders, delivery log, job queue with retries

## Phase 4 – Teams ✅
- Organizations, memberships, roles, invitations, teams
- Round robin, collective, group events with capacity

## Phase 5 – Advanced ✅
- Workflows (triggers/steps, SSRF-protected), signed webhooks
- Routing forms, embed SDK, analytics + CSV
- Public REST API v1 (keys, scopes, pagination, idempotency, rate limits, OpenAPI), TypeScript SDK, agent API

## Phase 6 – Release ✅ (partially external)
- Security review (SECURITY.md), tests (unit, integration, concurrency, E2E), docs, CI
- Deployment verification: dry run ✅, real one-click deploy ⛔ requires pushing the public repository and a Cloudflare account

## Next steps (post v0.1)
See "Open items" in PROGRESS.md – most notably live verification of Microsoft/Zoom/CalDAV, full UI translation, 2FA, RRULE expansion for ICS feeds and an MCP server on top of the agent API.
