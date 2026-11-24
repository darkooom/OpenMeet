# Progress

Legend: **[IMPL]** implemented · **[TESTED]** covered by automated tests · **[AUTO]** automated (CI/deploy) · **[MAN]** manual setup required · **[BLOCKED]** externally blocked · **[TODO]** open

Test run at release: `npm run test` → 7 files, 84 tests passed; `npm run test:e2e` → 1 E2E passed; lint + typecheck clean; `npm audit --omit=dev` → 0 vulnerabilities.

## Phase 1 – Foundation
| Feature | Status | Notes |
| --- | --- | --- |
| Single Worker + Static Assets, Hono API | [IMPL] [TESTED] | |
| D1 schema, migrations, Drizzle mirror | [IMPL] [TESTED] | schema/migration sync test |
| Runtime migrator (Wrangler-compatible) | [IMPL] [TESTED] | E2E boots an empty DB |
| Registration (open / invite-only / closed) | [IMPL] [TESTED] | |
| Login, logout, sessions, session revocation | [IMPL] [TESTED] | |
| E-mail verification | [IMPL] [TESTED] | requires e-mail provider [MAN]; auto-verified when none configured |
| Password reset (single-use tokens) | [IMPL] [TESTED] | |
| Google / Microsoft sign-in (OAuth + PKCE) | [IMPL] | needs OAuth apps [MAN]; not tested against live providers |
| Profile, time zone, language, time format | [IMPL] | |
| Setup wizard (8 steps), token-protected, atomic lock | [IMPL] [TESTED] | incl. concurrent completion test + E2E |
| Deploy-to-Cloudflare config (auto-provisioned D1, secrets prompt, deploy script) | [IMPL] [AUTO] | `wrangler deploy --dry-run` in CI |
| One-click deploy verified on a real account | [BLOCKED] | repository must be pushed to public `github.com/darkooom/OpenMeet`; no Cloudflare account access from the dev environment |

## Phase 2 – Functional MVP
| Feature | Status | Notes |
| --- | --- | --- |
| Dashboard (today, upcoming, recent, stats, link, integrations, notifications, activity) | [IMPL] | E2E visits it |
| Event types: all listed options | [IMPL] [TESTED] | durations, buffers, limits, questions, confirmation, private, redirect, branding |
| One-time / private links | [IMPL] [TESTED] | |
| Availability: schedules, multiple ranges, overrides (holiday, vacation, special hours, blocked ranges) | [IMPL] [TESTED] | |
| Event-specific schedules | [IMPL] | personal events |
| Slot engine: time zones, DST, notice, window, buffers, limits | [IMPL] [TESTED] | 21 unit tests |
| Atomic double-booking prevention | [IMPL] [TESTED] | 25 parallel requests → 1 booking; mutation-checked |
| Idempotency keys | [IMPL] [TESTED] | |
| Public pages `/u/:user`, `/u/:user/:slug`, `/team/:team/:slug`, `/book/:token`, `/reschedule/:token`, `/cancel/:token` | [IMPL] [TESTED] | |
| Booking management (confirm, decline, cancel, reschedule, no-show) | [IMPL] [TESTED] | |
| ICS download, Google Calendar link | [IMPL] [TESTED] | |
| Mobile layout, dark/light mode | [IMPL] | checked manually in the browser |

## Phase 3 – Integrations
| Feature | Status | Notes |
| --- | --- | --- |
| Adapter interface for calendars | [IMPL] | `integrations/calendar/types.ts` |
| Google Calendar (list, free/busy, create/update/delete, Meet links, token refresh) | [IMPL] [TESTED] [MAN] | tested with mocked Google API; live test needs OAuth app |
| Microsoft 365 / Outlook (+ Teams links) | [IMPL] [MAN] | not tested (no mock tests, no live account) |
| CalDAV | [IMPL] [MAN] | collection URL must be entered manually (no discovery); not tested live |
| ICS feeds (read-only busy) | [IMPL] [TESTED] | RRULE expansion [TODO] |
| Target calendar, multiple calendars, sync status | [IMPL] | |
| Zoom meetings | [IMPL] [MAN] | not tested live |
| Jitsi, custom video, phone, in-person | [IMPL] [TESTED] | |
| E-mail: Resend | [IMPL] [TESTED] [MAN] | mocked API test incl. ICS attachment |
| E-mail: Brevo, Postmark | [IMPL] [MAN] | not tested live |
| Templates (en/de): confirmation, pending, organizer, cancel, reschedule, decline, reminders 24 h / 1 h, no-show follow-up | [IMPL] [TESTED] | |
| Custom e-mail templates | [IMPL] | via workflow "Send e-mail" steps; built-in templates are not editable in the UI [TODO] |
| Job queue: retries, backoff, idempotency, delivery logs | [IMPL] [TESTED] | |
| App works without e-mail provider, clearly signalled | [IMPL] [TESTED] | |

## Phase 4 – Teams
| Feature | Status | Notes |
| --- | --- | --- |
| Organizations, memberships, roles | [IMPL] [TESTED] | |
| Invitations (link + e-mail) | [IMPL] [TESTED] | |
| Teams, team managers, team members | [IMPL] [TESTED] | |
| Round robin (least-booked available host) | [IMPL] [TESTED] | |
| Collective | [IMPL] [TESTED] | |
| Group events with atomic capacity | [IMPL] [TESTED] | |
| Team statistics | [IMPL] | bookings per member (30 days) |
| Team availability | [IMPL] | derived from each host's default schedule; no separate team schedule entity |
| Organization branding | [IMPL] | brand colour/logo on team booking pages |
| Shared integrations (org-level calendar accounts) | [TODO] | integrations are per user; OAuth apps are instance-wide |

## Phase 5 – Advanced
| Feature | Status | Notes |
| --- | --- | --- |
| Workflow builder (7 triggers, 6 actions) | [IMPL] [TESTED] | |
| SSRF protection | [IMPL] [TESTED] | |
| Signed webhooks + retries + log | [IMPL] [TESTED] | |
| Routing forms (fields, conditions, fallback, embed) | [IMPL] [TESTED] | |
| Embed SDK (inline, popup, floating, theme, origin-checked messages) | [IMPL] | not covered by automated tests |
| Analytics (counts, by type/member, cancel & no-show rate, lead time, heatmap, conversion, sources/UTM, CSV) | [IMPL] | |
| REST API v1, scopes, pagination, rate limits, idempotency | [IMPL] [TESTED] | |
| OpenAPI spec | [IMPL] [TESTED] | |
| TypeScript SDK | [IMPL] | typechecked, no runtime tests |
| Agent service API (NOVA / Hermes) with service tokens & audit log | [IMPL] [TESTED] | |
| MCP server | [TODO] | architecture prepared (agent API) |

## Phase 6 – Release
| Feature | Status | Notes |
| --- | --- | --- |
| Security review | [IMPL] | SECURITY.md (self-assessment) |
| CI: install, lint, typecheck, unit, integration, build, audit, E2E | [AUTO] | `.github/workflows/ci.yml` – runs once pushed |
| Documentation | [IMPL] | README, ARCHITECTURE, DEPLOYMENT, docs/ |
| Screenshots of the real app | [IMPL] | docs/screenshots |

## Known gaps / open items
- [TODO] Full UI translation (UI is English; e-mails en/de; dates localised)
- [TODO] Two-factor authentication
- [TODO] Built-in e-mail template editor
- [TODO] CalDAV discovery, ICS RRULE expansion
- [TODO] Org-level shared calendar connections
- [TODO] Attendees cannot reschedule group sessions (cancel + rebook instead)
- [TODO] Reschedule of round-robin bookings keeps the assigned host (no re-assignment)
- [TODO] MCP server
- [BLOCKED] Live verification of the Deploy button, Microsoft, Zoom, CalDAV, Brevo, Postmark (needs accounts/credentials)
