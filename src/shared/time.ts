/**
 * Time-zone utilities built only on Intl (available in browsers and the
 * Workers runtime). All instants are UTC epoch milliseconds; wall-clock
 * values are expressed as { date: "YYYY-MM-DD", minute: 0..1439 } in an
 * IANA time zone. DST transitions are handled by resolving offsets for the
 * concrete instant instead of assuming a fixed offset.
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatterCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
  /** YYYY-MM-DD */
  date: string;
  /** minutes since local midnight */
  minuteOfDay: number;
}

export function toZonedParts(utcMs: number, tz: string): ZonedParts {
  const parts = partsFormatter(tz).formatToParts(new Date(utcMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const second = Number(get("second"));
  const weekday = WEEKDAYS[get("weekday")] ?? 0;
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday,
    date: `${year.toString().padStart(4, "0")}-${pad(month)}-${pad(day)}`,
    minuteOfDay: hour * 60 + minute,
  };
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Offset of `tz` from UTC at the given instant, in minutes (e.g. +60 for CET). */
export function tzOffsetMinutes(utcMs: number, tz: string): number {
  const p = toZonedParts(utcMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = Math.floor(utcMs / 1000) * 1000;
  return Math.round((asUtc - truncated) / MINUTE);
}

export function parseDate(date: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`Invalid date: ${date}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

/**
 * Convert a local wall-clock time to a UTC instant. For times that do not
 * exist (spring-forward gap) the instant is shifted forward by the gap, for
 * ambiguous times (fall-back) the earlier instant is returned.
 */
export function zonedToUtc(date: string, minuteOfDay: number, tz: string): number {
  const { y, m, d } = parseDate(date);
  // `naive` treats the wall-clock as if it were UTC. The real instant is
  // naive - offset, where offset is one of the (at most two) offsets valid
  // around that day.
  const naive = Date.UTC(y, m - 1, d, 0, 0) + minuteOfDay * MINUTE;
  const offBefore = tzOffsetMinutes(naive - 14 * HOUR, tz);
  const offAfter = tzOffsetMinutes(naive + 14 * HOUR, tz);
  const target = toZonedParts(naive, "UTC");
  const matches: number[] = [];
  for (const off of new Set([offBefore, offAfter])) {
    const candidate = naive - off * MINUTE;
    const p = toZonedParts(candidate, tz);
    if (p.date === target.date && p.minuteOfDay === target.minuteOfDay) matches.push(candidate);
  }
  if (matches.length > 0) return Math.min(...matches);
  // Non-existent local time (spring-forward gap): use the pre-transition offset,
  // which lands the same distance after the gap.
  return naive - offBefore * MINUTE;
}

export function addDays(date: string, days: number): string {
  const { y, m, d } = parseDate(date);
  const t = new Date(Date.UTC(y, m - 1, d) + days * DAY);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function weekdayOf(date: string): number {
  const { y, m, d } = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Monday-based ISO week key (YYYY-MM-DD of the Monday). */
export function weekKey(date: string): string {
  const wd = weekdayOf(date);
  const diff = wd === 0 ? -6 : 1 - wd;
  return addDays(date, diff);
}

export function minutesToHHMM(min: number): string {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

export function hhmmToMinutes(v: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) throw new Error(`Invalid time: ${v}`);
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 24 || mm > 59 || (h === 24 && mm !== 0)) throw new Error(`Invalid time: ${v}`);
  return h * 60 + mm;
}

export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart;
}
