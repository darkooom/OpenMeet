# OpenMeet API

Base URL: `https://<your-instance>/api/v1` · OpenAPI 3.1: `GET /api/v1/openapi.json`

## Authentication

Create a key in **Settings → API keys**. Keys are shown once and stored hashed.

```
Authorization: Bearer om_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

| Scope | Allows |
| --- | --- |
| `event_types:read` / `event_types:write` | list/read, create/deactivate personal event types |
| `bookings:read` / `bookings:write` | list/read, create/cancel/reschedule bookings |
| `availability:read` | free slots |
| `teams:read`, `users:read`, `calendars:read` | read-only access |
| `webhooks:read` / `webhooks:write` | manage webhooks |
| `agent` | the agent service API (`/agent/*`) |

A key acts as its owner: it sees and changes exactly what the owner may (same tenant checks as the dashboard). Revoked or expired keys get `401`, missing scopes `403`.

**Rate limit:** 600 requests per minute per key (`429` + `Retry-After`).

## Conventions

- Times: UTC epoch milliseconds (`start`, `startAt`); availability also returns ISO strings.
- Errors: `{ "error": { "code": "slot_unavailable", "message": "…", "details": … } }`
- Pagination: `?limit=50&cursor=<nextCursor>`; responses contain `nextCursor` (null on the last page).
- Idempotency: send `Idempotency-Key: <8–100 chars>` on `POST /bookings`. Repeating the request returns the original booking with `200` and `"replay": true`.

## Examples

```bash
# Free slots for the next 7 days
curl -H "Authorization: Bearer $KEY" "$BASE/api/v1/availability?eventTypeId=$ET"

# Book
curl -X POST -H "Authorization: Bearer $KEY" -H "Idempotency-Key: crm-4711" -H "content-type: application/json" \
  -d '{"eventTypeId":"'$ET'","start":1796034600000,"name":"Ada","email":"ada@example.com","timezone":"Europe/Berlin"}' \
  "$BASE/api/v1/bookings"

# Cancel
curl -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" -d '{"reason":"No longer needed"}' "$BASE/api/v1/bookings/$ID/cancel"
```

A `409 slot_unavailable` means someone else took the time in the meantime – fetch availability again.

## Webhooks

Create via Settings → Webhooks or `POST /api/v1/webhooks`. Events: `booking.created`, `booking.confirmed`, `booking.cancelled`, `booking.rescheduled`, `booking.no_show`.

```
POST <your url>
content-type: application/json
x-openmeet-event: booking.created
x-openmeet-signature: t=1796034600,v1=5f0c…   # HMAC-SHA256(secret, "<t>.<raw body>")

{ "id": "…", "event": "booking.created", "createdAt": "…", "data": { …booking… } }
```

Verify the signature and reject timestamps older than 5 minutes (`verifyWebhookSignature` in the SDK). Non-2xx responses are retried with exponential backoff (up to 8 attempts); 4xx (except 408/429) are not retried.

## Agent service API (AI assistants such as NOVA / Hermes)

Create a **service token** (Settings → API keys → Type: Service token, scope `agent`). Every call is written to the audit log.

| Method & path | Purpose |
| --- | --- |
| `GET /agent/event-types` | bookable event types |
| `GET /agent/availability?eventTypeId=&from=&to=` | free slots |
| `GET /agent/bookings?status=` | bookings |
| `POST /agent/bookings` | book (supports `Idempotency-Key`) |
| `POST /agent/bookings/:id/reschedule` | `{ "start": <ms> }` |
| `POST /agent/bookings/:id/cancel` | `{ "reason": "…" }` |
| `POST /agent/booking-links` | single-use booking link `{ eventTypeId, singleUse, expiresInDays }` |
| `GET /agent/agenda?date=YYYY-MM-DD` | day overview in the owner's time zone |

Agents cannot bypass permissions: a token only reaches event types and bookings its owner can manage.

## TypeScript SDK

See [`sdk/`](../sdk/README.md).
