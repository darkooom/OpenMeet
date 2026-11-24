/**
 * Booking engine.
 *
 * Atomicity: every booking writes one `reservations` row per host inside a
 * single D1 batch (= one SQLite transaction). The BEFORE INSERT trigger
 * `reservations_no_overlap_insert` aborts the whole batch if an active,
 * overlapping reservation for the same host exists. D1 executes write
 * transactions serially on the database's single primary, so two concurrent
 * requests can never both pass the check. Group capacity is enforced the same
 * way by `booking_attendees_capacity`. The availability computation before the
 * write is only a fast path / UX check – correctness lives in the database.
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import {
  bookingAttendees,
  bookingHosts,
  bookings,
  contacts,
  eventTypes,
  privateLinks,
  reservations,
  users,
  type Booking,
  type EventType,
} from "../../database/schema";
import type { AppVariables, Env } from "../env";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { newId, newToken } from "../lib/ids";
import { parseJson } from "../lib/json";
import { encryptString, sha256Hex } from "../security/crypto";
import { MINUTE, DAY } from "../../shared/time";
import type { BookingQuestion, BookingRequest, EventLocation } from "../../shared/schemas";
import { eventTypeHostUsers, getSlots } from "./availability";
import { enqueueStatement } from "./jobs";

type Db = AppVariables["db"];

export type BookingEvent = "booking.created" | "booking.confirmed" | "booking.cancelled" | "booking.rescheduled" | "booking.no_show" | "booking.rejected";

export interface CreateBookingResult {
  bookingId: string;
  attendeeId: string;
  manageToken: string;
  status: Booking["status"];
  startAt: number;
  endAt: number;
  hostIds: string[];
  joined: boolean;
  idempotentReplay?: boolean;
}

function isConstraint(err: unknown, marker: string): boolean {
  const msg = err instanceof Error ? `${err.message} ${(err as { cause?: Error }).cause?.message ?? ""}` : String(err);
  return msg.includes(marker);
}

export function validateAnswers(questions: BookingQuestion[], answers: BookingRequest["answers"]): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const q of questions) {
    const v = answers[q.id];
    const empty = v == null || v === "" || (Array.isArray(v) && v.length === 0) || v === false;
    if (q.required && empty) throw badRequest(`"${q.label}" is required`, { field: q.id });
    if (empty) continue;
    if ((q.type === "select" || q.type === "radio") && q.options && typeof v === "string" && !q.options.includes(v)) {
      throw badRequest(`Invalid option for "${q.label}"`, { field: q.id });
    }
    if (q.type === "checkbox" && q.options && Array.isArray(v) && v.some((x) => !q.options!.includes(x))) {
      throw badRequest(`Invalid option for "${q.label}"`, { field: q.id });
    }
    clean[q.id] = v;
  }
  return clean;
}

function resolveLocation(et: EventType, requested: BookingRequest["location"]): { type: string | null; value: string | null } {
  const locations = parseJson<EventLocation[]>(et.locations, []);
  if (locations.length === 0) return { type: null, value: null };
  const chosen = requested ? locations.find((l) => l.type === requested.type) : locations[0];
  if (!chosen) throw badRequest("Selected location is not offered for this event type");
  if (chosen.type === "attendee_phone") {
    const phone = requested?.value?.trim();
    if (!phone || !/^[+0-9 ()/-]{5,30}$/.test(phone)) throw badRequest("Please provide a valid phone number");
    return { type: chosen.type, value: phone };
  }
  return { type: chosen.type, value: chosen.value ?? null };
}

async function roundRobinOrder(db: Db, et: EventType, candidateIds: string[]): Promise<string[]> {
  if (candidateIds.length <= 1) return candidateIds;
  const since = Date.now() - 30 * DAY;
  const counts = await db
    .select({ userId: bookingHosts.userId, n: sql<number>`count(*)` })
    .from(bookingHosts)
    .innerJoin(bookings, eq(bookings.id, bookingHosts.bookingId))
    .where(and(eq(bookings.eventTypeId, et.id), inArray(bookingHosts.userId, candidateIds), gte(bookings.createdAt, since), inArray(bookings.status, ["pending", "confirmed"])))
    .groupBy(bookingHosts.userId);
  const map = new Map(counts.map((c) => [c.userId, Number(c.n)]));
  const hosts = await eventTypeHostUsers(db, et);
  const priority = new Map(hosts.map((h, i) => [h.id, hosts.length - i]));
  return [...candidateIds].sort((a, b) => (map.get(a) ?? 0) - (map.get(b) ?? 0) || (priority.get(b) ?? 0) - (priority.get(a) ?? 0) || a.localeCompare(b));
}

async function claimPrivateLink(db: Db, et: EventType, token: string | undefined): Promise<string | null> {
  if (!et.isPrivate) return null;
  if (!token) throw notFound("Event type not found");
  const hash = await sha256Hex(token);
  const link = await db.select().from(privateLinks).where(and(eq(privateLinks.tokenHash, hash), eq(privateLinks.eventTypeId, et.id))).get();
  if (!link || (link.expiresAt && link.expiresAt < Date.now())) throw new AppError(410, "link_expired", "This booking link is no longer valid");
  if (link.singleUse) {
    const claimed = await db
      .update(privateLinks)
      .set({ usedAt: Date.now() })
      .where(and(eq(privateLinks.id, link.id), sql`${privateLinks.usedAt} IS NULL`))
      .returning({ id: privateLinks.id })
      .get();
    if (!claimed) throw new AppError(410, "link_used", "This one-time booking link has already been used");
  }
  return link.id;
}

async function releasePrivateLink(db: Db, linkId: string | null) {
  if (linkId) await db.update(privateLinks).set({ usedAt: null }).where(eq(privateLinks.id, linkId));
}

export async function createBooking(env: Env, db: Db, req: BookingRequest, ctx: { idempotencyKey?: string | null; now?: number }): Promise<CreateBookingResult> {
  if (ctx.idempotencyKey) {
    const existing = await db.select().from(bookings).where(eq(bookings.idempotencyKey, ctx.idempotencyKey)).get();
    if (existing) return replay(db, existing);
  }
  const et = await db.select().from(eventTypes).where(eq(eventTypes.id, req.eventTypeId)).get();
  if (!et || !et.isActive) throw notFound("Event type not found");
  const durations = [et.duration, ...parseJson<number[]>(et.durationOptions, [])];
  const duration = req.duration ?? et.duration;
  if (!durations.includes(duration)) throw badRequest("Unsupported duration");
  const answers = validateAnswers(parseJson<BookingQuestion[]>(et.questions, []), req.answers);
  const location = resolveLocation(et, req.location);
  const startAt = req.start;
  const endAt = startAt + duration * MINUTE;
  if (startAt % MINUTE !== 0) throw badRequest("Invalid start time");

  const linkId = await claimPrivateLink(db, et, req.privateLinkToken);
  try {
    const { slots } = await getSlots(env, db, et, { from: startAt, to: startAt + 1, duration, now: ctx.now });
    const slot = slots.find((s) => s.start === startAt);
    if (!slot) throw conflict("slot_unavailable", "This time is no longer available. Please pick another slot.");

    const token = newToken(24);
    const tokenHash = await sha256Hex(token);
    const tokenEnc = await encryptString(env.ENCRYPTION_KEY, token, "manage-token");
    const status: Booking["status"] = et.requiresConfirmation ? "pending" : "confirmed";

    // Group events: join an existing occurrence if there is one.
    if (et.kind === "group") {
      const joined = await tryJoinGroup(env, db, et, startAt, req, answers, tokenHash, tokenEnc, token);
      if (joined) return joined;
    }

    let candidates: string[][];
    if (et.kind === "collective") candidates = [slot.hostIds];
    else if (et.kind === "round_robin") candidates = (await roundRobinOrder(db, et, slot.hostIds)).map((h) => [h]);
    else candidates = [[slot.hostIds[0]!]];

    let lastErr: unknown = null;
    for (const hostIds of candidates) {
      try {
        return await insertBooking(env, db, { et, hostIds, startAt, endAt, status, req, answers, location, tokenHash, tokenEnc, token, idempotencyKey: ctx.idempotencyKey ?? null });
      } catch (err) {
        lastErr = err;
        if (isConstraint(err, "SLOT_UNAVAILABLE")) {
          if (et.kind === "group") {
            const joined = await tryJoinGroup(env, db, et, startAt, req, answers, tokenHash, tokenEnc, token);
            if (joined) return joined;
          }
          continue;
        }
        if (ctx.idempotencyKey && isConstraint(err, "UNIQUE") && isConstraint(err, "idempotency")) {
          const existing = await db.select().from(bookings).where(eq(bookings.idempotencyKey, ctx.idempotencyKey)).get();
          if (existing) return replay(db, existing);
        }
        throw err;
      }
    }
    if (lastErr && !isConstraint(lastErr, "SLOT_UNAVAILABLE")) throw lastErr;
    throw conflict("slot_unavailable", "This time was just booked by someone else. Please pick another slot.");
  } catch (err) {
    await releasePrivateLink(db, linkId);
    throw err;
  }
}

async function replay(db: Db, b: Booking): Promise<CreateBookingResult> {
  const hosts = await db.select({ u: bookingHosts.userId }).from(bookingHosts).where(eq(bookingHosts.bookingId, b.id));
  const att = await db.select({ id: bookingAttendees.id }).from(bookingAttendees).where(eq(bookingAttendees.bookingId, b.id)).get();
  return {
    bookingId: b.id,
    attendeeId: att?.id ?? "",
    manageToken: "",
    status: b.status,
    startAt: b.startAt,
    endAt: b.endAt,
    hostIds: hosts.map((h) => h.u),
    joined: false,
    idempotentReplay: true,
  };
}

interface InsertArgs {
  et: EventType;
  hostIds: string[];
  startAt: number;
  endAt: number;
  status: Booking["status"];
  req: BookingRequest;
  answers: Record<string, unknown>;
  location: { type: string | null; value: string | null };
  tokenHash: string;
  tokenEnc: string;
  token: string;
  idempotencyKey: string | null;
}

async function insertBooking(env: Env, db: Db, a: InsertArgs): Promise<CreateBookingResult> {
  const now = Date.now();
  const bookingId = newId();
  const attendeeId = newId();
  const organizer = a.hostIds[0]!;
  const title = `${a.et.title} – ${a.req.name}`;
  const blockStart = a.startAt - a.et.bufferBefore * MINUTE;
  const blockEnd = a.endAt + a.et.bufferAfter * MINUTE;
  const stmts = [
    db.insert(bookings).values({
      id: bookingId,
      eventTypeId: a.et.id,
      organizerUserId: organizer,
      title,
      startAt: a.startAt,
      endAt: a.endAt,
      status: a.status,
      locationType: a.location.type,
      locationValue: a.location.value,
      idempotencyKey: a.idempotencyKey,
      source: a.req.source ?? null,
      utm: a.req.utm ? JSON.stringify(a.req.utm) : null,
      createdAt: now,
      updatedAt: now,
      confirmedAt: a.status === "confirmed" ? now : null,
    }),
    ...a.hostIds.map((uid) => db.insert(bookingHosts).values({ bookingId, userId: uid })),
    ...a.hostIds.map((uid) => db.insert(reservations).values({ id: newId(), bookingId, userId: uid, startAt: blockStart, endAt: blockEnd, active: true })),
    db.insert(bookingAttendees).values({
      id: attendeeId,
      bookingId,
      name: a.req.name,
      email: a.req.email,
      timezone: a.req.timezone,
      locale: a.req.locale ?? null,
      answers: JSON.stringify(a.answers),
      manageTokenHash: a.tokenHash,
      manageTokenEnc: a.tokenEnc,
      createdAt: now,
    }),
    ...a.hostIds.map((uid) => upsertContact(db, uid, a.req.email, a.req.name, now)),
  ];
  const [first, ...rest] = stmts;
  await db.batch([first!, ...rest]);
  await dispatchBookingEvent(env, a.status === "pending" ? "booking.created" : "booking.created", bookingId, { attendeeId });
  return { bookingId, attendeeId, manageToken: a.token, status: a.status, startAt: a.startAt, endAt: a.endAt, hostIds: a.hostIds, joined: false };
}

function upsertContact(db: Db, ownerUserId: string, email: string, name: string, now: number) {
  return db
    .insert(contacts)
    .values({ id: newId(), ownerUserId, email, name, bookingsCount: 1, lastBookedAt: now, createdAt: now })
    .onConflictDoUpdate({
      target: [contacts.ownerUserId, contacts.email],
      set: { name, bookingsCount: sql`${contacts.bookingsCount} + 1`, lastBookedAt: now },
    });
}

async function tryJoinGroup(
  env: Env,
  db: Db,
  et: EventType,
  startAt: number,
  req: BookingRequest,
  answers: Record<string, unknown>,
  tokenHash: string,
  tokenEnc: string,
  token: string,
): Promise<CreateBookingResult | null> {
  const existing = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.eventTypeId, et.id), eq(bookings.startAt, startAt), inArray(bookings.status, ["pending", "confirmed"])))
    .get();
  if (!existing) return null;
  const dup = await db
    .select({ id: bookingAttendees.id })
    .from(bookingAttendees)
    .where(and(eq(bookingAttendees.bookingId, existing.id), eq(bookingAttendees.email, req.email), eq(bookingAttendees.status, "active")))
    .get();
  if (dup) throw conflict("already_booked", "You are already registered for this session.");
  const attendeeId = newId();
  const now = Date.now();
  const hosts = await db.select({ u: bookingHosts.userId }).from(bookingHosts).where(eq(bookingHosts.bookingId, existing.id));
  try {
    await db.batch([
      db.insert(bookingAttendees).values({
        id: attendeeId,
        bookingId: existing.id,
        name: req.name,
        email: req.email,
        timezone: req.timezone,
        locale: req.locale ?? null,
        answers: JSON.stringify(answers),
        manageTokenHash: tokenHash,
        manageTokenEnc: tokenEnc,
        createdAt: now,
      }),
      ...hosts.map((h) => upsertContact(db, h.u, req.email, req.name, now)),
    ]);
  } catch (err) {
    if (isConstraint(err, "CAPACITY_REACHED")) throw conflict("capacity_reached", "This session is fully booked.");
    throw err;
  }
  await dispatchBookingEvent(env, "booking.created", existing.id, { attendeeId });
  return {
    bookingId: existing.id,
    attendeeId,
    manageToken: token,
    status: existing.status,
    startAt: existing.startAt,
    endAt: existing.endAt,
    hostIds: hosts.map((h) => h.u),
    joined: true,
  };
}

export async function dispatchBookingEvent(env: Env, event: BookingEvent, bookingId: string, extra: Record<string, unknown> = {}): Promise<void> {
  await enqueueStatement(env.DB, "booking.event", { event, bookingId, ...extra, at: Date.now() }, { maxAttempts: 8 }).run();
}

export async function findAttendeeByToken(db: Db, token: string) {
  if (!token || token.length > 200) return null;
  const hash = await sha256Hex(token);
  const row = await db
    .select({ a: bookingAttendees, b: bookings, et: eventTypes })
    .from(bookingAttendees)
    .innerJoin(bookings, eq(bookings.id, bookingAttendees.bookingId))
    .innerJoin(eventTypes, eq(eventTypes.id, bookings.eventTypeId))
    .where(eq(bookingAttendees.manageTokenHash, hash))
    .get();
  return row ?? null;
}

/** Cancels the whole booking (organizer) or a single group attendee. */
export async function cancelBooking(env: Env, db: Db, bookingId: string, opts: { by: "organizer" | "attendee"; attendeeId?: string; reason?: string | null }) {
  const booking = await db.select().from(bookings).where(eq(bookings.id, bookingId)).get();
  if (!booking) throw notFound("Booking not found");
  if (booking.status === "cancelled" || booking.status === "rejected") throw conflict("already_cancelled", "This booking is already cancelled.");
  const now = Date.now();
  const activeAttendees = await db.select().from(bookingAttendees).where(and(eq(bookingAttendees.bookingId, bookingId), eq(bookingAttendees.status, "active")));
  const partial = opts.by === "attendee" && opts.attendeeId && activeAttendees.length > 1;
  if (partial) {
    await db.update(bookingAttendees).set({ status: "cancelled" }).where(eq(bookingAttendees.id, opts.attendeeId!));
    await dispatchBookingEvent(env, "booking.cancelled", bookingId, { attendeeId: opts.attendeeId, partial: true, reason: opts.reason ?? null, by: opts.by });
    return { partial: true };
  }
  await db.batch([
    db
      .update(bookings)
      .set({ status: "cancelled", cancelledAt: now, cancelReason: opts.reason ?? null, cancelledBy: opts.by, updatedAt: now })
      .where(eq(bookings.id, bookingId)),
    db.update(reservations).set({ active: false }).where(eq(reservations.bookingId, bookingId)),
  ]);
  await dispatchBookingEvent(env, "booking.cancelled", bookingId, { reason: opts.reason ?? null, by: opts.by, attendeeId: opts.attendeeId ?? null });
  return { partial: false };
}

export async function rescheduleBooking(env: Env, db: Db, bookingId: string, newStart: number, opts: { by: "organizer" | "attendee"; attendeeId?: string; reason?: string | null }) {
  const booking = await db.select().from(bookings).where(eq(bookings.id, bookingId)).get();
  if (!booking) throw notFound("Booking not found");
  if (booking.status === "cancelled" || booking.status === "rejected") throw conflict("booking_cancelled", "Cancelled bookings cannot be rescheduled.");
  const et = await db.select().from(eventTypes).where(eq(eventTypes.id, booking.eventTypeId)).get();
  if (!et) throw notFound("Event type not found");
  if (et.kind === "group") throw badRequest("Group sessions cannot be moved by attendees. Cancel and book a new session instead.");
  if (booking.startAt <= Date.now()) throw badRequest("Past bookings cannot be rescheduled.");
  const duration = Math.round((booking.endAt - booking.startAt) / MINUTE);
  const hostRows = await db.select({ u: bookingHosts.userId }).from(bookingHosts).where(eq(bookingHosts.bookingId, bookingId));
  const hostIds = hostRows.map((h) => h.u);
  const { slots } = await getSlots(env, db, et, { from: newStart, to: newStart + 1, duration, excludeBookingId: bookingId, onlyHostIds: hostIds });
  const slot = slots.find((s) => s.start === newStart);
  const hostsFree = slot && (et.kind === "collective" ? hostIds.every((h) => slot.hostIds.includes(h)) : hostIds.some((h) => slot.hostIds.includes(h)));
  if (!hostsFree) throw conflict("slot_unavailable", "This time is not available. Please pick another slot.");
  const now = Date.now();
  const newEnd = newStart + duration * MINUTE;
  const previous = { startAt: booking.startAt, endAt: booking.endAt };
  try {
    await db.batch([
      db.update(reservations).set({ active: false }).where(eq(reservations.bookingId, bookingId)),
      ...hostIds.map((uid) =>
        db.insert(reservations).values({
          id: newId(),
          bookingId,
          userId: uid,
          startAt: newStart - et.bufferBefore * MINUTE,
          endAt: newEnd + et.bufferAfter * MINUTE,
          active: true,
        }),
      ),
      db.delete(reservations).where(and(eq(reservations.bookingId, bookingId), eq(reservations.active, false))),
      db.update(bookings).set({ startAt: newStart, endAt: newEnd, updatedAt: now }).where(eq(bookings.id, bookingId)),
    ]);
  } catch (err) {
    if (isConstraint(err, "SLOT_UNAVAILABLE")) throw conflict("slot_unavailable", "This time was just booked by someone else.");
    throw err;
  }
  await dispatchBookingEvent(env, "booking.rescheduled", bookingId, { previous, by: opts.by, reason: opts.reason ?? null });
  return { startAt: newStart, endAt: newEnd };
}

export async function setBookingDecision(env: Env, db: Db, bookingId: string, decision: "confirm" | "reject", reason?: string | null) {
  const booking = await db.select().from(bookings).where(eq(bookings.id, bookingId)).get();
  if (!booking) throw notFound("Booking not found");
  if (booking.status !== "pending") throw conflict("not_pending", "Only pending bookings can be confirmed or rejected.");
  const now = Date.now();
  if (decision === "confirm") {
    await db.update(bookings).set({ status: "confirmed", confirmedAt: now, updatedAt: now }).where(eq(bookings.id, bookingId));
    await dispatchBookingEvent(env, "booking.confirmed", bookingId);
  } else {
    await db.batch([
      db.update(bookings).set({ status: "rejected", cancelReason: reason ?? null, cancelledAt: now, cancelledBy: "organizer", updatedAt: now }).where(eq(bookings.id, bookingId)),
      db.update(reservations).set({ active: false }).where(eq(reservations.bookingId, bookingId)),
    ]);
    await dispatchBookingEvent(env, "booking.rejected", bookingId, { reason: reason ?? null });
  }
}

export async function markNoShow(env: Env, db: Db, bookingId: string, attendeeId: string | null, noShow: boolean) {
  const now = Date.now();
  if (attendeeId) await db.update(bookingAttendees).set({ noShow }).where(and(eq(bookingAttendees.id, attendeeId), eq(bookingAttendees.bookingId, bookingId)));
  else await db.update(bookingAttendees).set({ noShow }).where(eq(bookingAttendees.bookingId, bookingId));
  await db.update(bookings).set({ noShow, updatedAt: now }).where(eq(bookings.id, bookingId));
  if (noShow) await dispatchBookingEvent(env, "booking.no_show", bookingId, { attendeeId });
}

/** Full booking view for the dashboard / API. */
export async function bookingDetails(db: Db, bookingIds: string[]) {
  if (bookingIds.length === 0) return [];
  const [rows, attendees, hosts] = await Promise.all([
    db
      .select({ b: bookings, et: { id: eventTypes.id, title: eventTypes.title, slug: eventTypes.slug, color: eventTypes.color, kind: eventTypes.kind, teamId: eventTypes.teamId } })
      .from(bookings)
      .innerJoin(eventTypes, eq(eventTypes.id, bookings.eventTypeId))
      .where(inArray(bookings.id, bookingIds)),
    db.select().from(bookingAttendees).where(inArray(bookingAttendees.bookingId, bookingIds)),
    db
      .select({ bookingId: bookingHosts.bookingId, id: users.id, name: users.name, email: users.email })
      .from(bookingHosts)
      .innerJoin(users, eq(users.id, bookingHosts.userId))
      .where(inArray(bookingHosts.bookingId, bookingIds)),
  ]);
  const order = new Map(bookingIds.map((id, i) => [id, i]));
  return rows
    .sort((a, b) => (order.get(a.b.id) ?? 0) - (order.get(b.b.id) ?? 0))
    .map((r) => ({
      id: r.b.id,
      title: r.b.title,
      status: r.b.status,
      startAt: r.b.startAt,
      endAt: r.b.endAt,
      locationType: r.b.locationType,
      locationValue: r.b.locationValue,
      meetingUrl: r.b.meetingUrl,
      cancelReason: r.b.cancelReason,
      noShow: r.b.noShow,
      source: r.b.source,
      utm: parseJson<Record<string, string> | null>(r.b.utm, null),
      createdAt: r.b.createdAt,
      eventType: r.et,
      hosts: hosts.filter((h) => h.bookingId === r.b.id).map(({ bookingId: _b, ...h }) => h),
      attendees: attendees
        .filter((a) => a.bookingId === r.b.id)
        .map((a) => ({ id: a.id, name: a.name, email: a.email, timezone: a.timezone, status: a.status, noShow: a.noShow, answers: parseJson<Record<string, unknown>>(a.answers, {}) })),
    }));
}
