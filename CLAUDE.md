# CLAUDE.md – working on OpenMeet

## Commands
- `npm run dev` – wrangler dev (:8787) + Vite (:5173, proxies /api, /auth)
- `npm run build` – Vite build to `dist/client` (the Worker serves it)
- `npm run typecheck`, `npm run lint`
- `npm run test:unit` (Node), `npm run test:integration` (workerd + real D1), `npm run test:e2e` (Playwright against wrangler dev with an empty DB)
- `npm run check:deploy` – build + `wrangler deploy --dry-run`

## Layout
- `src/server` – Worker (Hono). `routes/` HTTP, `services/` domain logic, `integrations/` providers, `security/` crypto/SSRF/rate limits, `middleware/` context/auth/CSRF
- `src/web` – React SPA (pages, layouts, lib); `src/components/ui` – UI kit
- `src/shared` – code used by both sides (Zod schemas, time-zone math)
- `src/database` – Drizzle schema + runtime migrator; SQL in `migrations/`

## Rules
- Times are UTC epoch ms everywhere; convert with `src/shared/time.ts` only.
- Never bypass `services/permissions.ts` when touching tenant data; return 404 for foreign IDs.
- Booking writes must go through `services/booking.ts` (D1 batch + triggers). Do not add "check then insert" logic elsewhere.
- New migration = new SQL file (statements separated by `--> statement-breakpoint`) + entry in `src/database/migrate.ts` + Drizzle schema update.
- Secrets/tokens are stored encrypted (`encryptString`) or hashed (`sha256Hex`); never log them (use `redactString`).
- Outbound requests to user-supplied URLs must use `safeFetch` / `assertSafeOutboundUrl`.
- Mock providers only in tests (`vi.spyOn(globalThis, "fetch")`), never in runtime code.
- Keep PROGRESS.md statuses honest.
