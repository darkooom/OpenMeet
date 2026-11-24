/**
 * Unauthenticated endpoints used by booking pages, manage links and routing forms.
 * All of them are rate limited per (hashed) IP and expose only public fields.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { bookingHosts, eventTypes, organizations, pageViews, privateLinks, routingForms, routingResponses, teams, users, type EventType, type User } from "../../database/schema";
import type { AppEnv, AppVariables } from "../env";
import { AppError, badRequest, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { parseJson } from "../lib/json";
import { parseWith, readBody, readQuery } from "../lib/validate";
import { bookingRequestSchema, routingRuleSchema, routingTargetSchema, type EventLocation, type RoutingRule, type RoutingTarget } from "../../shared/schemas";
import { DAY } from "../../shared/time";
import { eventTypeHostUsers, getSlots } from "../services/availability";
import { bookingDetails, cancelBooking, createBooking, findAttendeeByToken, rescheduleBooking } from "../services/booking";
import { audit } from "../services/audit";
import { rateLimit } from "../security/rate-limit";
import { credentialStatus } from "../services/settings";
import { sha256Hex } from "../security/crypto";
import { buildIcs } from "../services/ics";
import { evaluateRouting } from "../services/routing";

type Db = AppVariables["db"];

export const publicRoutes = new Hono<AppEnv>();

function publicHost(u: User) {
  return { name: u.name, username: u.username, avatarUrl: u.avatarUrl, brandColor: u.brandColor, bio: u.bio };
}

function publicLocations(et: EventType) {
  return parseJson<EventLocation[]>(et.locations, []).map((l) => ({ type: l.type, value: l.type === "in_person" ? (l.value ?? null) : null }));
}

async function publicEventType(db: Db, et: EventType) {
  const hosts = await eventTypeHostUsers(db, et);
  let team: { name: string; slug: string; brandColor: string | null; logoUrl: string | null } | null = null;
  if (et.teamId) {
    const t = await db
      .select({ name: teams.name, slug: teams.slug, brandColor: organizations.brandColor, logoUrl: organizations.logoUrl })
      .from(teams)
      .innerJoin(organizations, eq(organizations.id, teams.orgId))
      .where(eq(teams.id, et.teamId))
      .get();
    team = t ?? null;
  }
  return {
    id: et.id,
    title: et.title,
    slug: et.slug,
    description: et.description,
    kind: et.kind,
    duration: et.duration,
    durationOptions: parseJson<number[]>(et.durationOptions, []),
    color: et.color,
    brandColor: et.brandColor ?? team?.brandColor ?? hosts[0]?.brandColor ?? null,
    locations: publicLocations(et),
    questions: parseJson<unknown[]>(et.questions, []),
    seats: et.seats,
    requiresConfirmation: et.requiresConfirmation,
    confirmationMessage: et.confirmationMessage,
    redirectUrl: et.redirectUrl,
    hosts: hosts.map(publicHost),
    team,
  };
}

async function ownerPublic(db: Db, username: string): Promise<User> {
  const u = await db.select().from(users).where(eq(users.username, username.toLowerCase())).get();
  if (!u || u.disabledAt) throw notFound("Page not found");
  return u;
}

publicRoutes.use("*", rateLimit("public", 240, 60));

publicRoutes.get("/users/:username", async (c) => {
  const db = c.get("db");
  const u = await ownerPublic(db, c.req.param("username"));
  const list = u.emailVerifiedAt
    ? await db
        .select()
        .from(eventTypes)
        .where(and(eq(eventTypes.ownerUserId, u.id), eq(eventTypes.isActive, true), eq(eventTypes.isPrivate, false)))
    : [];
  return c.json({
    user: publicHost(u),
    eventTypes: list.map((et) => ({ id: et.id, title: et.title, slug: et.slug, description: et.description, duration: et.duration, color: et.color, kind: et.kind })),
  });
});

publicRoutes.get("/users/:username/:slug", async (c) => {
  const db = c.get("db");
  const u = await ownerPublic(db, c.req.param("username"));
  if (!u.emailVerifiedAt) throw notFound("Page not found");
  const et = await db
    .select()
    .from(eventTypes)
    .where(and(eq(eventTypes.ownerUserId, u.id), eq(eventTypes.slug, c.req.param("slug")), eq(eventTypes.isActive, true), eq(eventTypes.isPrivate, false)))
    .get();
  if (!et) throw notFound("Event type not found");
  return c.json({ eventType: await publicEventType(db, et) });
});

publicRoutes.get("/teams/:teamSlug", async (c) => {
  const db = c.get("db");
  const team = await db.select().from(teams).where(eq(teams.slug, c.req.param("teamSlug"))).get();
  if (!team) throw notFound("Team not found");
  const list = await db.select().from(eventTypes).where(and(eq(eventTypes.teamId, team.id), eq(eventTypes.isActive, true), eq(eventTypes.isPrivate, false)));
  return c.json({
    team: { name: team.name, slug: team.slug, description: team.description },
    eventTypes: list.map((et) => ({ id: et.id, title: et.title, slug: et.slug, description: et.description, duration: et.duration, color: et.color, kind: et.kind })),
  });
});

publicRoutes.get("/teams/:teamSlug/:slug", async (c) => {
  const db = c.get("db");
  const team = await db.select().from(teams).where(eq(teams.slug, c.req.param("teamSlug"))).get();
  if (!team) throw notFound("Team not found");
  const et = await db
    .select()
    .from(eventTypes)
    .where(and(eq(eventTypes.teamId, team.id), eq(eventTypes.slug, c.req.param("slug")), eq(eventTypes.isActive, true), eq(eventTypes.isPrivate, false)))
    .get();
  if (!et) throw notFound("Event type not found");
  return c.json({ eventType: await publicEventType(db, et) });
});

async function resolvePrivateLink(db: Db, token: string): Promise<EventType> {
  const link = await db
    .select()
    .from(privateLinks)
    .where(and(eq(privateLinks.tokenHash, await sha256Hex(token)), isNull(privateLinks.usedAt), or(isNull(privateLinks.expiresAt), gt(privateLinks.expiresAt, Date.now()))))
    .get();
  if (!link) throw new AppError(410, "link_invalid", "This booking link is no longer valid.");
  const et = await db.select().from(eventTypes).where(eq(eventTypes.id, link.eventTypeId)).get();
  if (!et || !et.isActive) throw new AppError(410, "link_invalid", "This booking link is no longer valid.");
  return et;
}

publicRoutes.get("/links/:token", async (c) => {
  const db = c.get("db");
  const et = await resolvePrivateLink(db, c.req.param("token"));
  return c.json({ eventType: await publicEventType(db, et) });
});

const slotsQuery = z.object({
  from: z.coerce.number().int(),
  to: z.coerce.number().int(),
  duration: z.coerce.number().int().min(5).max(720).optional(),
  token: z.string().max(200).optional(),
});

async function bookableEventType(db: Db, id: string, token?: string): Promise<EventType> {
  const et = await db.select().from(eventTypes).where(eq(eventTypes.id, id)).get();
  if (!et || !et.isActive) throw notFound("Event type not found");
  if (et.isPrivate) {
    if (!token) throw notFound("Event type not found");
    const viaLink = await resolvePrivateLink(db, token);
    if (viaLink.id !== et.id) throw notFound("Event type not found");
  }
  if (et.ownerUserId) {
    const owner = await db.select({ v: users.emailVerifiedAt, d: users.disabledAt }).from(users).where(eq(users.id, et.ownerUserId)).get();
    if (!owner?.v || owner.d) throw notFound("Event type not found");
  }
  return et;
}

function clampRange(from: number, to: number) {
  if (to <= from) throw badRequest("Invalid range");
  if (to - from > 45 * DAY) throw badRequest("Range too large (max. 45 days)");
}

publicRoutes.get("/event-types/:id/slots", async (c) => {
  const db = c.get("db");
  const q = readQuery(c, slotsQuery);
  clampRange(q.from, q.to);
  const et = await bookableEventType(db, c.req.param("id"), q.token);
  const durations = [et.duration, ...parseJson<number[]>(et.durationOptions, [])];
  if (q.duration && !durations.includes(q.duration)) throw badRequest("Unsupported duration");
  const { slots, timezone } = await getSlots(c.env, db, et, { from: q.from, to: q.to, duration: q.duration });
  c.header("cache-control", "no-store");
  return c.json({ timezone, slots: slots.map((s) => ({ start: s.start, end: s.end, seatsAvailable: s.joinsBooking ? true : undefined })) });
});

publicRoutes.post("/event-types/:id/view", async (c) => {
  const db = c.get("db");
  const et = await db.select({ id: eventTypes.id }).from(eventTypes).where(eq(eventTypes.id, c.req.param("id"))).get();
  if (!et) return c.json({ ok: true });
  const day = new Date().toISOString().slice(0, 10);
  await db
    .insert(pageViews)
    .values({ day, eventTypeId: et.id, views: 1 })
    .onConflictDoUpdate({ target: [pageViews.day, pageViews.eventTypeId], set: { views: sql`${pageViews.views} + 1` } });
  return c.json({ ok: true });
});

publicRoutes.post("/bookings", rateLimit("book", 20, 600), async (c) => {
  const db = c.get("db");
  const input = await readBody(c, bookingRequestSchema);
  await bookableEventType(db, input.eventTypeId, input.privateLinkToken);
  const idem = c.req.header("idempotency-key");
  if (idem && !/^[A-Za-z0-9_-]{8,100}$/.test(idem)) throw badRequest("Invalid Idempotency-Key");
  const result = await createBooking(c.env, db, input, { idempotencyKey: idem ? `pub:${idem}` : null });
  if (!result.idempotentReplay) await audit(db, { type: "public" }, "booking.created", { type: "booking", id: result.bookingId }, { eventTypeId: input.eventTypeId }, c.get("ip"));
  const [details] = await bookingDetails(db, [result.bookingId]);
  return c.json(
    {
      booking: {
        id: result.bookingId,
        status: result.status,
        startAt: result.startAt,
        endAt: result.endAt,
        meetingUrl: details?.meetingUrl ?? null,
        locationType: details?.locationType ?? null,
        locationValue: details?.locationValue ?? null,
        hosts: details?.hosts.map((h) => ({ name: h.name })) ?? [],
      },
      manageToken: result.manageToken || null,
      replay: !!result.idempotentReplay,
      emailEnabled: (await credentialStatus(db)).email,
    },
    result.idempotentReplay ? 200 : 201,
  );
});

async function attendeeView(c: Context<AppEnv>, token: string) {
  const db = c.get("db");
  const row = await findAttendeeByToken(db, token);
  if (!row) throw notFound("Booking not found");
  const [d] = await bookingDetails(db, [row.b.id]);
  const hosts = await db.select({ name: users.name }).from(bookingHosts).innerJoin(users, eq(users.id, bookingHosts.userId)).where(eq(bookingHosts.bookingId, row.b.id));
  return {
    row,
    view: {
      id: row.b.id,
      status: row.a.status === "cancelled" ? "cancelled" : row.b.status,
      startAt: row.b.startAt,
      endAt: row.b.endAt,
      meetingUrl: d?.meetingUrl ?? null,
      locationType: d?.locationType ?? null,
      locationValue: d?.locationValue ?? null,
      cancelReason: row.b.cancelReason,
      attendee: { name: row.a.name, email: row.a.email, timezone: row.a.timezone },
      hosts,
      eventType: await publicEventType(db, row.et),
    },
  };
}

publicRoutes.get("/bookings/:token", async (c) => {
  const { view } = await attendeeView(c, c.req.param("token"));
  return c.json({ booking: view });
});

publicRoutes.get("/bookings/:token/ics", async (c) => {
  const { view } = await attendeeView(c, c.req.param("token"));
  const ics = buildIcs([
    {
      uid: `${view.id}@openmeet`,
      start: view.startAt,
      end: view.endAt,
      summary: `${view.eventType.title} (${view.hosts.map((h) => h.name).join(", ")})`,
      location: view.meetingUrl ?? view.locationValue ?? undefined,
      status: view.status === "cancelled" ? "CANCELLED" : "CONFIRMED",
    },
  ]);
  return c.body(ics, 200, { "content-type": "text/calendar; charset=utf-8", "content-disposition": `attachment; filename="meeting.ics"` });
});

publicRoutes.get("/bookings/:token/slots", async (c) => {
  const db = c.get("db");
  const q = readQuery(c, slotsQuery);
  clampRange(q.from, q.to);
  const { row } = await attendeeView(c, c.req.param("token"));
  const hostIds = (await db.select({ u: bookingHosts.userId }).from(bookingHosts).where(eq(bookingHosts.bookingId, row.b.id))).map((h) => h.u);
  const duration = Math.round((row.b.endAt - row.b.startAt) / 60000);
  const { slots, timezone } = await getSlots(c.env, db, row.et, { from: q.from, to: q.to, duration, excludeBookingId: row.b.id, onlyHostIds: hostIds });
  const valid = row.et.kind === "collective" ? slots.filter((s) => hostIds.every((h) => s.hostIds.includes(h))) : slots;
  return c.json({ timezone, slots: valid.map((s) => ({ start: s.start, end: s.end })) });
});

publicRoutes.post("/bookings/:token/cancel", rateLimit("manage", 20, 600), async (c) => {
  const db = c.get("db");
  const { row } = await attendeeView(c, c.req.param("token"));
  const { reason } = await readBody(c, z.object({ reason: z.string().max(1000).nullish() }));
  if (row.a.status === "cancelled") throw new AppError(409, "already_cancelled", "This booking is already cancelled.");
  await cancelBooking(c.env, db, row.b.id, { by: "attendee", attendeeId: row.a.id, reason });
  await audit(db, { type: "public" }, "booking.cancelled_by_attendee", { type: "booking", id: row.b.id }, undefined, c.get("ip"));
  return c.json({ ok: true });
});

publicRoutes.post("/bookings/:token/reschedule", rateLimit("manage", 20, 600), async (c) => {
  const db = c.get("db");
  const { row } = await attendeeView(c, c.req.param("token"));
  const { start, reason } = await readBody(c, z.object({ start: z.number().int(), reason: z.string().max(1000).nullish() }));
  if (row.a.status === "cancelled") throw new AppError(409, "already_cancelled", "This booking is cancelled.");
  const res = await rescheduleBooking(c.env, db, row.b.id, start, { by: "attendee", attendeeId: row.a.id, reason });
  await audit(db, { type: "public" }, "booking.rescheduled_by_attendee", { type: "booking", id: row.b.id }, { from: row.b.startAt, to: start }, c.get("ip"));
  return c.json({ ok: true, ...res });
});

// ---- Routing forms ----------------------------------------------------------

publicRoutes.get("/forms/:id", async (c) => {
  const db = c.get("db");
  const f = await db.select().from(routingForms).where(and(eq(routingForms.id, c.req.param("id")), eq(routingForms.isActive, true))).get();
  if (!f) throw notFound("Form not found");
  return c.json({ form: { id: f.id, name: f.name, description: f.description, fields: parseJson<unknown[]>(f.fields, []) } });
});

publicRoutes.post("/forms/:id/submit", rateLimit("form", 30, 600), async (c) => {
  const db = c.get("db");
  const f = await db.select().from(routingForms).where(and(eq(routingForms.id, c.req.param("id")), eq(routingForms.isActive, true))).get();
  if (!f) throw notFound("Form not found");
  const { answers } = await readBody(c, z.object({ answers: z.record(z.string(), z.union([z.string().max(2000), z.array(z.string().max(200)).max(50)])) }));
  const fields = parseJson<{ id: string; label: string; required?: boolean; options?: string[] }[]>(f.fields, []);
  for (const field of fields) {
    const v = answers[field.id];
    if (field.required && (v == null || v === "" || (Array.isArray(v) && v.length === 0))) throw badRequest(`"${field.label}" is required`, { field: field.id });
  }
  const rules = parseJson<RoutingRule[]>(f.rules, []).map((r) => parseWith(routingRuleSchema, r));
  const fallback = parseWith(routingTargetSchema, parseJson<RoutingTarget>(f.fallback, { type: "message", message: "Thank you!" }));
  const target = evaluateRouting(rules, fallback, answers);
  const responseId = newId();
  await db.insert(routingResponses).values({ id: responseId, formId: f.id, answers: JSON.stringify(answers), target: JSON.stringify(target), createdAt: Date.now() });
  let resolved: Record<string, unknown> = { ...target };
  if (target.type === "event_type") {
    const et = await db.select().from(eventTypes).where(eq(eventTypes.id, target.eventTypeId)).get();
    if (et?.ownerUserId) {
      const owner = await db.select({ username: users.username }).from(users).where(eq(users.id, et.ownerUserId)).get();
      resolved = { type: "event_type", path: `/u/${owner?.username}/${et.slug}` };
    } else if (et?.teamId) {
      const team = await db.select({ slug: teams.slug }).from(teams).where(eq(teams.id, et.teamId)).get();
      resolved = { type: "event_type", path: `/team/${team?.slug}/${et.slug}` };
    } else resolved = { type: "message", message: "This form is not configured correctly." };
  }
  // Prefill the booking form with name / e-mail answers when present.
  const prefill: Record<string, string> = {};
  for (const field of fields) {
    const v = answers[field.id];
    if (typeof v !== "string") continue;
    if (/e-?mail/i.test(field.label) || field.id === "email") prefill.email = v;
    if (/^name$|full name|your name/i.test(field.label) || field.id === "name") prefill.name = v;
  }
  return c.json({ target: resolved, responseId, prefill });
});
