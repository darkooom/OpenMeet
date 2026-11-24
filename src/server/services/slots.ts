/**
 * Pure slot computation. No I/O – everything the engine needs is passed in,
 * which keeps it deterministic and unit-testable (DST, buffers, limits ...).
 */
import { MINUTE, DAY, addDays, overlaps, toZonedParts, weekKey, weekdayOf, zonedToUtc } from "../../shared/time";

export interface WeeklyRule {
  weekday: number;
  startMinute: number;
  endMinute: number;
}
export interface DateOverride {
  date: string;
  kind: "available" | "unavailable";
  startMinute: number | null;
  endMinute: number | null;
}
export interface HostSchedule {
  timezone: string;
  rules: WeeklyRule[];
  overrides: DateOverride[];
}
export interface Interval {
  start: number;
  end: number;
}
export interface HostInput {
  userId: string;
  schedule: HostSchedule;
  /** Busy intervals (already including buffers of existing bookings). */
  busy: Interval[];
  /** Number of bookings of this event type per local date (host tz). */
  bookingsPerDay?: Record<string, number>;
  /** Number of bookings of this event type per local ISO week (Monday date). */
  bookingsPerWeek?: Record<string, number>;
}
export interface SlotQuery {
  rangeStart: number;
  rangeEnd: number;
  now: number;
  duration: number;
  slotInterval?: number | null;
  minNoticeMinutes: number;
  bookingWindowDays: number;
  bufferBefore: number;
  bufferAfter: number;
  maxPerDay?: number | null;
  maxPerWeek?: number | null;
  /** any: at least one host must be free (one-on-one, round robin, group) – all: collective */
  mode: "any" | "all";
  hosts: HostInput[];
  /**
   * Group events: starts of existing bookings with free seats. These stay
   * bookable even though the host is "busy" with that very booking.
   */
  openGroupStarts?: { start: number; hostIds: string[] }[];
}
export interface Slot {
  start: number;
  end: number;
  hostIds: string[];
  /** set when joining an existing group booking */
  joinsBooking?: boolean;
}

/** Availability windows of one schedule (UTC) covering [from, to]. */
export function availabilityWindows(schedule: HostSchedule, from: number, to: number): Interval[] {
  const startDate = addDays(toZonedParts(from, schedule.timezone).date, -1);
  const endDate = addDays(toZonedParts(to, schedule.timezone).date, 1);
  const overridesByDate = new Map<string, DateOverride[]>();
  for (const o of schedule.overrides) {
    const list = overridesByDate.get(o.date) ?? [];
    list.push(o);
    overridesByDate.set(o.date, list);
  }
  const windows: Interval[] = [];
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
    const overrides = overridesByDate.get(date);
    let local: { start: number; end: number }[];
    if (overrides && overrides.length > 0) {
      if (overrides.some((o) => o.kind === "unavailable" && (o.startMinute == null || o.endMinute == null))) {
        local = [];
      } else {
        const available = overrides.filter((o) => o.kind === "available" && o.startMinute != null && o.endMinute != null);
        // Partial-day blocks: base = overrides with "available" or weekly rules, minus blocked ranges.
        const base =
          available.length > 0
            ? available.map((o) => ({ start: o.startMinute!, end: o.endMinute! }))
            : schedule.rules.filter((r) => r.weekday === weekdayOf(date)).map((r) => ({ start: r.startMinute, end: r.endMinute }));
        const blocks = overrides
          .filter((o) => o.kind === "unavailable" && o.startMinute != null && o.endMinute != null)
          .map((o) => ({ start: o.startMinute!, end: o.endMinute! }));
        local = subtractIntervals(base, blocks);
      }
    } else {
      local = schedule.rules.filter((r) => r.weekday === weekdayOf(date)).map((r) => ({ start: r.startMinute, end: r.endMinute }));
    }
    for (const w of local) {
      const start = zonedToUtc(date, w.start, schedule.timezone);
      const end = w.end >= 1440 ? zonedToUtc(addDays(date, 1), 0, schedule.timezone) : zonedToUtc(date, w.end, schedule.timezone);
      if (end > start && end > from && start < to) windows.push({ start, end });
    }
  }
  return mergeIntervals(windows);
}

export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

export function subtractIntervals(base: Interval[], blocks: Interval[]): Interval[] {
  let result = mergeIntervals(base);
  for (const b of blocks) {
    const next: Interval[] = [];
    for (const r of result) {
      if (!overlaps(r.start, r.end, b.start, b.end)) {
        next.push(r);
        continue;
      }
      if (b.start > r.start) next.push({ start: r.start, end: b.start });
      if (b.end < r.end) next.push({ start: b.end, end: r.end });
    }
    result = next;
  }
  return result;
}

function hostFreeSlots(host: HostInput, q: SlotQuery, earliest: number, latest: number): Map<number, string> {
  const result = new Map<number, string>();
  const step = (q.slotInterval && q.slotInterval > 0 ? q.slotInterval : q.duration) * MINUTE;
  const dur = q.duration * MINUTE;
  const windows = availabilityWindows(host.schedule, q.rangeStart - DAY, q.rangeEnd + DAY);
  const busy = [...host.busy].sort((a, b) => a.start - b.start);
  for (const w of windows) {
    for (let s = w.start; s + dur <= w.end; s += step) {
      if (s < earliest || s > latest || s < q.rangeStart || s >= q.rangeEnd) continue;
      const blockStart = s - q.bufferBefore * MINUTE;
      const blockEnd = s + dur + q.bufferAfter * MINUTE;
      if (busy.some((b) => overlaps(blockStart, blockEnd, b.start, b.end))) continue;
      const local = toZonedParts(s, host.schedule.timezone);
      if (q.maxPerDay && (host.bookingsPerDay?.[local.date] ?? 0) >= q.maxPerDay) continue;
      if (q.maxPerWeek && (host.bookingsPerWeek?.[weekKey(local.date)] ?? 0) >= q.maxPerWeek) continue;
      result.set(s, host.userId);
    }
  }
  return result;
}

export function computeSlots(q: SlotQuery): Slot[] {
  const earliest = q.now + q.minNoticeMinutes * MINUTE;
  const latest = q.now + q.bookingWindowDays * DAY;
  const dur = q.duration * MINUTE;
  const perHost = q.hosts.map((h) => hostFreeSlots(h, q, earliest, latest));
  const starts = new Map<number, string[]>();
  perHost.forEach((m) => {
    for (const [s, uid] of m) {
      const list = starts.get(s) ?? [];
      list.push(uid);
      starts.set(s, list);
    }
  });
  const slots: Slot[] = [];
  for (const [start, hostIds] of starts) {
    if (q.mode === "all" && hostIds.length !== q.hosts.length) continue;
    slots.push({ start, end: start + dur, hostIds });
  }
  for (const g of q.openGroupStarts ?? []) {
    if (g.start < earliest || g.start > latest || g.start < q.rangeStart || g.start >= q.rangeEnd) continue;
    const existing = slots.find((s) => s.start === g.start);
    if (existing) existing.joinsBooking = true;
    else slots.push({ start: g.start, end: g.start + dur, hostIds: g.hostIds, joinsBooking: true });
  }
  return slots.sort((a, b) => a.start - b.start);
}
