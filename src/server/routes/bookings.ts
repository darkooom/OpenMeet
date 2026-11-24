import { Hono } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { bookingHosts, bookings, eventTypes } from "../../database/schema";
import { getSlots } from "../services/availability";
import type { AppEnv, AppVariables, SessionUser } from "../env";
import { badRequest, notFound } from "../lib/errors";
import { readBody, readQuery } from "../lib/validate";
import { audit } from "../services/audit";
import { bookingDetails, cancelBooking, markNoShow, rescheduleBooking, setBookingDecision } from "../services/booking";
import { requireBooking, visibleTeamIds } from "../services/permissions";
import { buildIcs } from "../services/ics";

type Db = AppVariables["db"];

/** Bookings visible to a user: own (host) bookings + bookings of teams they belong to / administer. */
export async function visibleBookingCondition(db: Db, user: SessionUser) {
  const teamIds = await visibleTeamIds(db, user.id);
  const hostSub = sql`${bookings.id} IN (SELECT booking_id FROM booking_hosts WHERE user_id = ${user.id})`;
  if (teamIds.length === 0) return hostSub;
  return or(hostSub, sql`${bookings.eventTypeId} IN (SELECT id FROM event_types WHERE team_id IN (${sql.join(teamIds.map((t) => sql`${t}`), sql`, `)}))`);
}

const listQuery = z.object({
  status: z.enum(["upcoming", "past", "pending", "cancelled", "all"]).default("upcoming"),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  eventTypeId: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().optional(),
});

export async function listBookings(db: Db, user: SessionUser, q: z.infer<typeof listQuery>) {
  const now = Date.now();
  const conds = [await visibleBookingCondition(db, user)];
  let ascending = true;
  if (q.status === "upcoming") conds.push(gte(bookings.endAt, now), inArray(bookings.status, ["confirmed", "pending"]));
  if (q.status === "past") {
    conds.push(lt(bookings.endAt, now), inArray(bookings.status, ["confirmed"]));
    ascending = false;
  }
  if (q.status === "pending") conds.push(eq(bookings.status, "pending"), gte(bookings.endAt, now));
  if (q.status === "cancelled") {
    conds.push(inArray(bookings.status, ["cancelled", "rejected"]));
    ascending = false;
  }
  if (q.from) conds.push(gte(bookings.startAt, q.from));
  if (q.to) conds.push(lt(bookings.startAt, q.to));
  if (q.eventTypeId) conds.push(eq(bookings.eventTypeId, q.eventTypeId));
  if (q.cursor) conds.push(ascending ? gte(bookings.startAt, q.cursor) : lt(bookings.startAt, q.cursor));
  const rows = await db
    .select({ id: bookings.id, startAt: bookings.startAt })
    .from(bookings)
    .where(and(...conds))
    .orderBy(ascending ? asc(bookings.startAt) : desc(bookings.startAt), asc(bookings.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const next = rows.length > q.limit ? rows[q.limit]!.startAt : null;
  return { bookings: await bookingDetails(db, page.map((r) => r.id)), nextCursor: next };
}

export const bookingRoutes = new Hono<AppEnv>();

bookingRoutes.get("/", async (c) => {
  const q = readQuery(c, listQuery);
  return c.json(await listBookings(c.get("db"), c.get("actor")!.user, q));
});

bookingRoutes.get("/:id", async (c) => {
  const db = c.get("db");
  const b = await requireBooking(db, c.get("actor")!.user, c.req.param("id"), "view");
  const [details] = await bookingDetails(db, [b.id]);
  return c.json({ booking: details });
});

bookingRoutes.get("/:id/ics", async (c) => {
  const db = c.get("db");
  const b = await requireBooking(db, c.get("actor")!.user, c.req.param("id"), "view");
  const [d] = await bookingDetails(db, [b.id]);
  if (!d) throw notFound();
  const ics = buildIcs([
    {
      uid: `${d.id}@openmeet`,
      start: d.startAt,
      end: d.endAt,
      summary: d.title,
      location: d.meetingUrl ?? d.locationValue ?? undefined,
      attendees: d.attendees.map((a) => ({ name: a.name, email: a.email })),
      status: d.status === "cancelled" ? "CANCELLED" : "CONFIRMED",
    },
  ]);
  return c.body(ics, 200, { "content-type": "text/calendar; charset=utf-8", "content-disposition": `attachment; filename="booking-${d.id}.ics"` });
});

bookingRoutes.get("/:id/slots", async (c) => {
  const db = c.get("db");
  const b = await requireBooking(db, c.get("actor")!.user, c.req.param("id"), "manage");
  const q = readQuery(c, z.object({ from: z.coerce.number().int(), to: z.coerce.number().int() }));
  if (q.to <= q.from || q.to - q.from > 45 * 86_400_000) throw badRequest("Invalid range");
  const et = await db.select().from(eventTypes).where(eq(eventTypes.id, b.eventTypeId)).get();
  if (!et) throw notFound();
  const hostIds = (await db.select({ u: bookingHosts.userId }).from(bookingHosts).where(eq(bookingHosts.bookingId, b.id))).map((h) => h.u);
  const { slots, timezone } = await getSlots(c.env, db, et, { from: q.from, to: q.to, duration: Math.round((b.endAt - b.startAt) / 60000), excludeBookingId: b.id, onlyHostIds: hostIds });
  const valid = et.kind === "collective" ? slots.filter((s) => hostIds.every((h) => s.hostIds.includes(h))) : slots;
  return c.json({ timezone, slots: valid.map((s) => ({ start: s.start, end: s.end })) });
});

bookingRoutes.post("/:id/cancel", async (c) => {
  const db = c.get("db");
  const b = await requireBooking(db, c.get("actor")!.user, c.req.param("id"), "manage");
  const { reason } = await readBody(c, z.object({ reason: z.string().max(1000).nullish() }));
  await cancelBooking(c.env, db, b.id, { by: "organizer", reason });
  await audit(db, c.get("actor"), "booking.cancelled", { type: "booking", id: b.id }, undefined, c.get("ip"));
  return c.json({ ok: true });
});

bookingRoutes.post("/:id/reschedule", async (c) => {
  const db = c.get("db");
  const b = await requireBooking(db, c.get("actor")!.user, c.req.param("id"), "manage");
  const { start, reason } = await readBody(c, z.object({ start: z.number().int(), reason: z.string().max(1000).nullish() }));
  const res = await rescheduleBooking(c.env, db, b.id, start, { by: "organizer", reason });
  await audit(db, c.get("actor"), "booking.rescheduled", { type: "booking", id: b.id }, { from: b.startAt, to: start }, c.get("ip"));
  return c.json({ ok: true, ...res });
});

bookingRoutes.post("/:id/confirm", async (c) => {
  const db = c.get("db");
  const b = await requireBooking(db, c.get("actor")!.user, c.req.param("id"), "manage");
  await setBookingDecision(c.env, db, b.id, "confirm");
  await audit(db, c.get("actor"), "booking.confirmed", { type: "booking", id: b.id }, undefined, c.get("ip"));
  return c.json({ ok: true });
});

bookingRoutes.post("/:id/reject", async (c) => {
  const db = c.get("db");
  const b = await requireBooking(db, c.get("actor")!.user, c.req.param("id"), "manage");
  const { reason } = await readBody(c, z.object({ reason: z.string().max(1000).nullish() }));
  await setBookingDecision(c.env, db, b.id, "reject", reason);
  await audit(db, c.get("actor"), "booking.rejected", { type: "booking", id: b.id }, undefined, c.get("ip"));
  return c.json({ ok: true });
});

bookingRoutes.post("/:id/no-show", async (c) => {
  const db = c.get("db");
  const b = await requireBooking(db, c.get("actor")!.user, c.req.param("id"), "manage");
  const input = await readBody(c, z.object({ attendeeId: z.string().max(40).nullish(), noShow: z.boolean().default(true) }));
  if (b.startAt > Date.now()) throw badRequest("No-shows can only be recorded after the meeting started.");
  await markNoShow(c.env, db, b.id, input.attendeeId ?? null, input.noShow);
  return c.json({ ok: true });
});

