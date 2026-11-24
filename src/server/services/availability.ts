/**
 * Loads everything the pure slot engine needs from D1 (+ external calendars).
 */
import { and, eq, gt, inArray, lt, ne } from "drizzle-orm";
import {
  availabilityRules,
  bookingAttendees,
  bookingHosts,
  bookings,
  dateOverrides,
  eventTypeHosts,
  eventTypes,
  reservations,
  schedules,
  teamMembers,
  users,
  type EventType,
  type User,
} from "../../database/schema";
import type { AppVariables, Env } from "../env";
import { notFound } from "../lib/errors";
import { DAY, toZonedParts, weekKey } from "../../shared/time";
import { computeSlots, type HostInput, type HostSchedule, type Interval, type Slot } from "./slots";
import { getExternalBusy } from "../integrations/calendar";

type Db = AppVariables["db"];

export async function eventTypeHostUsers(db: Db, et: EventType): Promise<User[]> {
  if (et.ownerUserId) {
    const u = await db.select().from(users).where(eq(users.id, et.ownerUserId)).get();
    return u && !u.disabledAt ? [u] : [];
  }
  const explicit = await db
    .select({ u: users, priority: eventTypeHosts.priority })
    .from(eventTypeHosts)
    .innerJoin(users, eq(users.id, eventTypeHosts.userId))
    .where(eq(eventTypeHosts.eventTypeId, et.id));
  if (explicit.length > 0) return explicit.filter((r) => !r.u.disabledAt).sort((a, b) => b.priority - a.priority).map((r) => r.u);
  const members = await db
    .select({ u: users })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(eq(teamMembers.teamId, et.teamId!));
  return members.filter((r) => !r.u.disabledAt).map((r) => r.u);
}

export async function loadSchedule(db: Db, scheduleId: string): Promise<HostSchedule | null> {
  const s = await db.select().from(schedules).where(eq(schedules.id, scheduleId)).get();
  if (!s) return null;
  const [rules, overrides] = await Promise.all([
    db.select().from(availabilityRules).where(eq(availabilityRules.scheduleId, scheduleId)),
    db.select().from(dateOverrides).where(eq(dateOverrides.scheduleId, scheduleId)),
  ]);
  return {
    timezone: s.timezone,
    rules: rules.map((r) => ({ weekday: r.weekday, startMinute: r.startMinute, endMinute: r.endMinute })),
    overrides: overrides.map((o) => ({ date: o.date, kind: o.kind, startMinute: o.startMinute, endMinute: o.endMinute })),
  };
}

async function hostSchedule(db: Db, et: EventType, user: User): Promise<HostSchedule> {
  if (et.scheduleId) {
    const s = await db.select({ userId: schedules.userId }).from(schedules).where(eq(schedules.id, et.scheduleId)).get();
    if (s?.userId === user.id) {
      const loaded = await loadSchedule(db, et.scheduleId);
      if (loaded) return loaded;
    }
  }
  const def =
    (await db.select({ id: schedules.id }).from(schedules).where(and(eq(schedules.userId, user.id), eq(schedules.isDefault, true))).get()) ??
    (await db.select({ id: schedules.id }).from(schedules).where(eq(schedules.userId, user.id)).get());
  if (def) {
    const loaded = await loadSchedule(db, def.id);
    if (loaded) return loaded;
  }
  return { timezone: user.timezone, rules: [], overrides: [] };
}

export interface SlotOptions {
  from: number;
  to: number;
  duration?: number;
  now?: number;
  excludeBookingId?: string;
  /** Skip external calendar lookups (used when the caller already checked). */
  skipExternal?: boolean;
  /** Restrict to these hosts (e.g. keep the assigned host on reschedule). */
  onlyHostIds?: string[];
}

export async function getSlots(env: Env, db: Db, et: EventType, opts: SlotOptions): Promise<{ slots: Slot[]; hosts: User[]; timezone: string }> {
  let hosts = await eventTypeHostUsers(db, et);
  if (opts.onlyHostIds) hosts = hosts.filter((h) => opts.onlyHostIds!.includes(h.id));
  if (hosts.length === 0) return { slots: [], hosts, timezone: "UTC" };
  const duration = opts.duration ?? et.duration;
  const now = opts.now ?? Date.now();
  const hostIds = hosts.map((h) => h.id);
  const lookFrom = opts.from - 8 * DAY;
  const lookTo = opts.to + 8 * DAY;

  const [resRows, etBookings, external] = await Promise.all([
    db
      .select({ userId: reservations.userId, start: reservations.startAt, end: reservations.endAt, bookingId: reservations.bookingId })
      .from(reservations)
      .where(and(inArray(reservations.userId, hostIds), eq(reservations.active, true), lt(reservations.startAt, opts.to + DAY), gt(reservations.endAt, opts.from - DAY))),
    db
      .select({ id: bookings.id, start: bookings.startAt, hostId: bookingHosts.userId })
      .from(bookings)
      .innerJoin(bookingHosts, eq(bookingHosts.bookingId, bookings.id))
      .where(
        and(
          eq(bookings.eventTypeId, et.id),
          inArray(bookings.status, ["pending", "confirmed"]),
          gt(bookings.startAt, lookFrom),
          lt(bookings.startAt, lookTo),
          opts.excludeBookingId ? ne(bookings.id, opts.excludeBookingId) : undefined,
        ),
      ),
    opts.skipExternal ? Promise.resolve(new Map<string, Interval[]>()) : getExternalBusy(env, db, hostIds, opts.from - DAY, opts.to + DAY),
  ]);

  const hostInputs: HostInput[] = [];
  for (const h of hosts) {
    const schedule = await hostSchedule(db, et, h);
    const busy: Interval[] = resRows
      .filter((r) => r.userId === h.id && r.bookingId !== opts.excludeBookingId)
      .map((r) => ({ start: r.start, end: r.end }));
    busy.push(...(external.get(h.id) ?? []));
    const perDay: Record<string, number> = {};
    const perWeek: Record<string, number> = {};
    for (const b of etBookings.filter((b) => b.hostId === h.id)) {
      const d = toZonedParts(b.start, schedule.timezone).date;
      perDay[d] = (perDay[d] ?? 0) + 1;
      const w = weekKey(d);
      perWeek[w] = (perWeek[w] ?? 0) + 1;
    }
    hostInputs.push({ userId: h.id, schedule, busy, bookingsPerDay: perDay, bookingsPerWeek: perWeek });
  }

  let openGroupStarts: { start: number; hostIds: string[] }[] | undefined;
  if (et.kind === "group" && et.seats > 1) {
    const groupRows = await db
      .select({ id: bookings.id, start: bookings.startAt, status: bookings.status })
      .from(bookings)
      .where(and(eq(bookings.eventTypeId, et.id), inArray(bookings.status, ["pending", "confirmed"]), gt(bookings.startAt, opts.from - 1), lt(bookings.startAt, opts.to)));
    openGroupStarts = [];
    for (const g of groupRows) {
      if (g.id === opts.excludeBookingId) continue;
      const count = await db
        .select({ id: bookingAttendees.id })
        .from(bookingAttendees)
        .where(and(eq(bookingAttendees.bookingId, g.id), eq(bookingAttendees.status, "active")));
      if (count.length < et.seats) {
        const hs = await db.select({ u: bookingHosts.userId }).from(bookingHosts).where(eq(bookingHosts.bookingId, g.id));
        openGroupStarts.push({ start: g.start, hostIds: hs.map((x) => x.u) });
      }
    }
    // Hosts stay busy for overlapping starts; only the exact start of a group
    // booking with free seats is re-offered (see computeSlots).
  }

  const slots = computeSlots({
    rangeStart: opts.from,
    rangeEnd: opts.to,
    now,
    duration,
    slotInterval: et.slotInterval,
    minNoticeMinutes: et.minNoticeMinutes,
    bookingWindowDays: et.bookingWindowDays,
    bufferBefore: et.bufferBefore,
    bufferAfter: et.bufferAfter,
    maxPerDay: et.maxPerDay,
    maxPerWeek: et.maxPerWeek,
    mode: et.kind === "collective" ? "all" : "any",
    hosts: hostInputs,
    openGroupStarts,
  });
  const tz = hostInputs[0]?.schedule.timezone ?? "UTC";
  return { slots, hosts, timezone: tz };
}

export async function getEventTypeOrThrow(db: Db, id: string): Promise<EventType> {
  const et = await db.select().from(eventTypes).where(eq(eventTypes.id, id)).get();
  if (!et) throw notFound("Event type not found");
  return et;
}
