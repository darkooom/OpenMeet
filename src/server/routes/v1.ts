/**
 * Public REST API v1 (API keys with scopes) and the agent service API used by
 * external AI agents (e.g. NOVA / Hermes). Agents use service tokens with the
 * "agent" scope and go through exactly the same permission checks as the
 * dashboard – there is no privileged bypass. Every agent call is audit logged.
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { calendarConnections, calendars, eventTypes, memberships, organizations, teamMembers, teams, webhooks } from "../../database/schema";
import type { AppEnv } from "../env";
import { AppError, badRequest, forbidden, unauthorized } from "../lib/errors";
import { newId, newToken } from "../lib/ids";
import { parseJson } from "../lib/json";
import { readBody, readQuery } from "../lib/validate";
import { WEBHOOK_EVENTS, bookingRequestSchema, eventTypeInputSchema, httpsUrlSchema, type ApiScope } from "../../shared/schemas";
import { DAY } from "../../shared/time";
import { audit } from "../services/audit";
import { getSlots } from "../services/availability";
import { bookingDetails, cancelBooking, createBooking, rescheduleBooking } from "../services/booking";
import { requireBooking, requireEventType } from "../services/permissions";
import { encryptString, sha256Hex } from "../security/crypto";
import { assertSafeOutboundUrl } from "../security/ssrf";
import { hitRateLimit } from "../security/rate-limit";
import { listBookings } from "./bookings";
import { listEventTypes, serializeEventType } from "./event-types";
import { privateLinks } from "../../database/schema";
import { openApiSpec } from "./openapi";

export const v1Routes = new Hono<AppEnv>();

v1Routes.get("/openapi.json", (c) => c.json(openApiSpec(c.get("baseUrl"))));

const apiAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const actor = c.get("actor");
  if (!actor || actor.type !== "api_key") throw unauthorized("Provide an API key: Authorization: Bearer om_live_...");
  const ok = await hitRateLimit(c.env.DB, "api", actor.apiKeyId, 600, 60);
  if (!ok) {
    c.header("Retry-After", "60");
    throw new AppError(429, "rate_limited", "Rate limit exceeded (600 requests/minute per key)");
  }
  await next();
};

function scope(...needed: ApiScope[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = c.get("actor");
    if (actor?.type !== "api_key") throw unauthorized();
    if (!needed.some((s) => actor.scopes.includes(s))) throw forbidden(`Missing scope: ${needed.join(" or ")}`);
    await next();
  };
}

v1Routes.use("/*", async (c, next) => {
  if (c.req.path.endsWith("/openapi.json")) return next();
  return apiAuth(c, next);
});

const user = (c: Context<AppEnv>) => c.get("actor")!.user;

v1Routes.get("/me", scope("users:read", "agent"), (c) => c.json({ user: user(c) }));
v1Routes.get("/users", scope("users:read"), (c) => c.json({ data: [user(c)], nextCursor: null }));

// ---- Event types --------------------------------------------------------------

v1Routes.get("/event-types", scope("event_types:read", "agent"), async (c) => {
  const list = await listEventTypes(c.get("db"), user(c));
  return c.json({ data: list, nextCursor: null });
});

v1Routes.get("/event-types/:id", scope("event_types:read"), async (c) => {
  const et = await requireEventType(c.get("db"), user(c), c.req.param("id"), "view");
  return c.json({ data: serializeEventType(et) });
});

v1Routes.post("/event-types", scope("event_types:write"), async (c) => {
  const db = c.get("db");
  const input = await readBody(c, eventTypeInputSchema);
  if (input.teamId) throw badRequest("Team event types can only be created in the dashboard");
  const id = newId();
  const now = Date.now();
  try {
    await db.insert(eventTypes).values({
      id,
      ownerUserId: user(c).id,
      title: input.title,
      slug: input.slug,
      description: input.description ?? null,
      kind: input.kind === "group" ? "group" : "one_on_one",
      duration: input.duration,
      durationOptions: JSON.stringify(input.durationOptions),
      color: input.color,
      locations: JSON.stringify(input.locations),
      minNoticeMinutes: input.minNoticeMinutes,
      bookingWindowDays: input.bookingWindowDays,
      bufferBefore: input.bufferBefore,
      bufferAfter: input.bufferAfter,
      maxPerDay: input.maxPerDay ?? null,
      maxPerWeek: input.maxPerWeek ?? null,
      seats: input.kind === "group" ? input.seats : 1,
      requiresConfirmation: input.requiresConfirmation,
      isPrivate: input.isPrivate,
      isActive: input.isActive,
      questions: JSON.stringify(input.questions),
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(`${err.message} ${(err as { cause?: Error }).cause?.message ?? ""}`)) throw new AppError(409, "slug_taken", "Slug already in use");
    throw err;
  }
  await audit(db, c.get("actor"), "api.event_type_created", { type: "event_type", id }, undefined, c.get("ip"));
  const et = await db.select().from(eventTypes).where(eq(eventTypes.id, id)).get();
  return c.json({ data: serializeEventType(et!) }, 201);
});

v1Routes.delete("/event-types/:id", scope("event_types:write"), async (c) => {
  const db = c.get("db");
  const et = await requireEventType(db, user(c), c.req.param("id"), "manage");
  await db.update(eventTypes).set({ isActive: false, updatedAt: Date.now() }).where(eq(eventTypes.id, et.id));
  return c.json({ ok: true });
});

// ---- Availability -----------------------------------------------------------

const availabilityQuery = z.object({
  eventTypeId: z.string().max(40),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  duration: z.coerce.number().int().optional(),
});

async function availability(c: Context<AppEnv>) {
  const q = readQuery(c, availabilityQuery);
  const from = q.from ?? Date.now();
  const to = q.to ?? from + 7 * DAY;
  if (to <= from || to - from > 45 * DAY) throw badRequest("Range must be between 1 ms and 45 days");
  const et = await requireEventType(c.get("db"), user(c), q.eventTypeId, "view");
  const { slots, timezone } = await getSlots(c.env, c.get("db"), et, { from, to, duration: q.duration });
  return { eventTypeId: et.id, timezone, slots: slots.map((s) => ({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString(), startMs: s.start })) };
}

v1Routes.get("/availability", scope("availability:read"), async (c) => c.json({ data: await availability(c) }));

// ---- Bookings ---------------------------------------------------------------

const listQuery = z.object({
  status: z.enum(["upcoming", "past", "pending", "cancelled", "all"]).default("upcoming"),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.coerce.number().int().optional(),
});

v1Routes.get("/bookings", scope("bookings:read"), async (c) => {
  const q = readQuery(c, listQuery);
  const res = await listBookings(c.get("db"), user(c), { ...q, eventTypeId: undefined });
  return c.json({ data: res.bookings, nextCursor: res.nextCursor });
});

v1Routes.get("/bookings/:id", scope("bookings:read"), async (c) => {
  const b = await requireBooking(c.get("db"), user(c), c.req.param("id"), "view");
  const [d] = await bookingDetails(c.get("db"), [b.id]);
  return c.json({ data: d });
});

async function apiCreateBooking(c: Context<AppEnv>) {
  const db = c.get("db");
  const input = await readBody(c, bookingRequestSchema);
  // API keys may only book event types the key owner can manage.
  await requireEventType(db, user(c), input.eventTypeId, "manage");
  const idem = c.req.header("idempotency-key");
  if (idem && !/^[A-Za-z0-9_-]{8,100}$/.test(idem)) throw badRequest("Invalid Idempotency-Key");
  const res = await createBooking(c.env, db, { ...input, source: input.source ?? "api", privateLinkToken: undefined }, { idempotencyKey: idem ? `api:${c.get("actor")!.type === "api_key" ? (c.get("actor") as { apiKeyId: string }).apiKeyId : ""}:${idem}` : null });
  const [d] = await bookingDetails(db, [res.bookingId]);
  await audit(db, c.get("actor"), "api.booking_created", { type: "booking", id: res.bookingId }, { replay: !!res.idempotentReplay }, c.get("ip"));
  return { data: d, replay: !!res.idempotentReplay };
}

v1Routes.post("/bookings", scope("bookings:write"), async (c) => {
  const out = await apiCreateBooking(c);
  return c.json(out, out.replay ? 200 : 201);
});

v1Routes.post("/bookings/:id/cancel", scope("bookings:write"), async (c) => {
  const db = c.get("db");
  const b = await requireBooking(db, user(c), c.req.param("id"), "manage");
  const { reason } = await readBody(c, z.object({ reason: z.string().max(1000).nullish() }));
  await cancelBooking(c.env, db, b.id, { by: "organizer", reason });
  await audit(db, c.get("actor"), "api.booking_cancelled", { type: "booking", id: b.id }, undefined, c.get("ip"));
  return c.json({ ok: true });
});

v1Routes.post("/bookings/:id/reschedule", scope("bookings:write"), async (c) => {
  const db = c.get("db");
  const b = await requireBooking(db, user(c), c.req.param("id"), "manage");
  const { start, reason } = await readBody(c, z.object({ start: z.number().int(), reason: z.string().max(1000).nullish() }));
  const res = await rescheduleBooking(c.env, db, b.id, start, { by: "organizer", reason });
  await audit(db, c.get("actor"), "api.booking_rescheduled", { type: "booking", id: b.id }, { to: start }, c.get("ip"));
  return c.json({ ok: true, ...res });
});

// ---- Teams / calendars --------------------------------------------------------

v1Routes.get("/teams", scope("teams:read"), async (c) => {
  const db = c.get("db");
  const rows = await db
    .select({ id: teams.id, name: teams.name, slug: teams.slug, role: teamMembers.role, organization: organizations.name })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .innerJoin(organizations, eq(organizations.id, teams.orgId))
    .where(eq(teamMembers.userId, user(c).id));
  const orgs = await db.select({ orgId: memberships.orgId, role: memberships.role }).from(memberships).where(eq(memberships.userId, user(c).id));
  return c.json({ data: rows, organizations: orgs, nextCursor: null });
});

v1Routes.get("/calendars", scope("calendars:read"), async (c) => {
  const db = c.get("db");
  const conns = await db
    .select({ id: calendarConnections.id, provider: calendarConnections.provider, accountEmail: calendarConnections.accountEmail, status: calendarConnections.status, lastSyncedAt: calendarConnections.lastSyncedAt })
    .from(calendarConnections)
    .where(eq(calendarConnections.userId, user(c).id));
  const cals = conns.length > 0 ? await db.select().from(calendars).where(inArray(calendars.connectionId, conns.map((x) => x.id))) : [];
  return c.json({ data: conns.map((x) => ({ ...x, calendars: cals.filter((k) => k.connectionId === x.id).map((k) => ({ id: k.id, name: k.name, checkConflicts: k.checkConflicts, isTarget: k.isTarget })) })) });
});

// ---- Webhooks -----------------------------------------------------------------

v1Routes.get("/webhooks", scope("webhooks:read"), async (c) => {
  const rows = await c.get("db").select().from(webhooks).where(eq(webhooks.ownerUserId, user(c).id));
  return c.json({ data: rows.map(({ secretEnc: _s, ...w }) => ({ ...w, events: parseJson(w.events, []) })) });
});

v1Routes.post("/webhooks", scope("webhooks:write"), async (c) => {
  const input = await readBody(c, z.object({ url: httpsUrlSchema, events: z.array(z.enum(WEBHOOK_EVENTS)).min(1) }));
  try {
    assertSafeOutboundUrl(input.url);
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : "Invalid URL");
  }
  const secret = `whsec_${newToken(24)}`;
  const id = newId();
  await c
    .get("db")
    .insert(webhooks)
    .values({ id, ownerUserId: user(c).id, url: input.url, secretEnc: await encryptString(c.env.ENCRYPTION_KEY, secret, "webhook"), events: JSON.stringify(input.events), isActive: true, createdAt: Date.now() });
  return c.json({ data: { id, url: input.url, events: input.events, secret } }, 201);
});

v1Routes.delete("/webhooks/:id", scope("webhooks:write"), async (c) => {
  await c
    .get("db")
    .delete(webhooks)
    .where(and(eq(webhooks.id, c.req.param("id")), eq(webhooks.ownerUserId, user(c).id)));
  return c.json({ ok: true });
});

// ---- Agent service API ----------------------------------------------------------

const agent = new Hono<AppEnv>();
agent.use("*", scope("agent"));
agent.use("*", async (c, next) => {
  await next();
  await audit(c.get("db"), c.get("actor"), `agent.${c.req.method.toLowerCase()}`, null, { path: new URL(c.req.url).pathname, status: c.res.status }, c.get("ip"));
});

agent.get("/event-types", async (c) => {
  const list = await listEventTypes(c.get("db"), user(c));
  return c.json({ data: list.filter((e) => e.isActive).map((e) => ({ id: e.id, title: e.title, slug: e.slug, duration: e.duration, kind: e.kind, team: e.team?.name ?? null })) });
});
agent.get("/availability", async (c) => c.json({ data: await availability(c) }));
agent.get("/bookings", async (c) => {
  const q = readQuery(c, listQuery);
  const res = await listBookings(c.get("db"), user(c), { ...q, eventTypeId: undefined });
  return c.json({ data: res.bookings, nextCursor: res.nextCursor });
});
agent.post("/bookings", async (c) => {
  const out = await apiCreateBooking(c);
  return c.json(out, out.replay ? 200 : 201);
});
agent.post("/bookings/:id/cancel", async (c) => {
  const db = c.get("db");
  const b = await requireBooking(db, user(c), c.req.param("id"), "manage");
  const { reason } = await readBody(c, z.object({ reason: z.string().max(1000).nullish() }));
  await cancelBooking(c.env, db, b.id, { by: "organizer", reason });
  return c.json({ ok: true });
});
agent.post("/bookings/:id/reschedule", async (c) => {
  const db = c.get("db");
  const b = await requireBooking(db, user(c), c.req.param("id"), "manage");
  const { start, reason } = await readBody(c, z.object({ start: z.number().int(), reason: z.string().max(1000).nullish() }));
  return c.json({ ok: true, ...(await rescheduleBooking(c.env, db, b.id, start, { by: "organizer", reason })) });
});
agent.post("/booking-links", async (c) => {
  const db = c.get("db");
  const input = await readBody(c, z.object({ eventTypeId: z.string().max(40), singleUse: z.boolean().default(true), expiresInDays: z.number().int().min(1).max(90).default(14) }));
  const et = await requireEventType(db, user(c), input.eventTypeId, "manage");
  const token = newToken(18);
  await db.insert(privateLinks).values({
    id: newId(),
    eventTypeId: et.id,
    tokenHash: await sha256Hex(token),
    singleUse: input.singleUse,
    expiresAt: Date.now() + input.expiresInDays * DAY,
    createdBy: user(c).id,
    createdAt: Date.now(),
  });
  return c.json({ data: { url: `${c.get("baseUrl")}/book/${token}`, expiresInDays: input.expiresInDays, singleUse: input.singleUse } }, 201);
});
agent.get("/agenda", async (c) => {
  const db = c.get("db");
  const date = c.req.query("date");
  const tz = user(c).timezone;
  const { zonedToUtc, toZonedParts } = await import("../../shared/time");
  const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : toZonedParts(Date.now(), tz).date;
  const from = zonedToUtc(day, 0, tz);
  const to = from + DAY;
  const res = await listBookings(db, user(c), { status: "all", from, to, limit: 100, eventTypeId: undefined });
  const active = res.bookings.filter((b) => b.status === "confirmed" || b.status === "pending");
  return c.json({ data: { date: day, timezone: tz, count: active.length, bookings: active } });
});

v1Routes.route("/agent", agent);

