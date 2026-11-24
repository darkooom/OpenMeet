/**
 * iCalendar (RFC 5545) generation and a tolerant parser for busy-time import.
 */
import { zonedToUtc } from "../../shared/time";
import type { Interval } from "./slots";

function fmtUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Folds lines longer than 75 octets as required by RFC 5545. */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let current = "";
  for (const ch of line) {
    if (new TextEncoder().encode(current + ch).length > (out.length === 0 ? 75 : 74)) {
      out.push(current);
      current = ch;
    } else current += ch;
  }
  out.push(current);
  return out.join("\r\n ");
}

export interface IcsEvent {
  uid: string;
  sequence?: number;
  start: number;
  end: number;
  summary: string;
  description?: string;
  location?: string;
  url?: string;
  organizer?: { name: string; email: string };
  attendees?: { name: string; email: string }[];
  status?: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
}

export function buildIcs(events: IcsEvent[], opts: { method?: "PUBLISH" | "REQUEST" | "CANCEL"; name?: string } = {}): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//OpenMeet//OpenMeet//EN", "CALSCALE:GREGORIAN"];
  if (opts.method) lines.push(`METHOD:${opts.method}`);
  if (opts.name) lines.push(`X-WR-CALNAME:${escapeText(opts.name)}`);
  const stamp = fmtUtc(Date.now());
  for (const e of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${e.uid}`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART:${fmtUtc(e.start)}`);
    lines.push(`DTEND:${fmtUtc(e.end)}`);
    lines.push(`SEQUENCE:${e.sequence ?? 0}`);
    lines.push(`SUMMARY:${escapeText(e.summary)}`);
    if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
    if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
    if (e.url) lines.push(`URL:${e.url}`);
    if (e.organizer) lines.push(`ORGANIZER;CN=${escapeText(e.organizer.name)}:mailto:${e.organizer.email}`);
    for (const a of e.attendees ?? []) lines.push(`ATTENDEE;CN=${escapeText(a.name)};ROLE=REQ-PARTICIPANT:mailto:${a.email}`);
    lines.push(`STATUS:${e.status ?? "CONFIRMED"}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

function unfold(text: string): string[] {
  return text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
}

function parseIcsDate(value: string, params: Record<string, string>): number | null {
  const v = value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly) {
    const date = `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
    return params.TZID ? zonedToUtc(date, 0, params.TZID) : Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return null;
  if (m[7] === "Z") return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const minute = Number(m[4]) * 60 + Number(m[5]);
  try {
    return zonedToUtc(date, minute, params.TZID ?? "UTC");
  } catch {
    return zonedToUtc(date, minute, "UTC");
  }
}

/**
 * Extracts busy intervals from VEVENTs (non-recurring events plus the first
 * occurrence of recurring ones; RRULE expansion is not implemented).
 * Transparent or cancelled events are ignored.
 */
export function parseIcsBusy(text: string, from: number, to: number): Interval[] {
  const lines = unfold(text);
  const out: Interval[] = [];
  let cur: { start?: number | null; end?: number | null; transparent?: boolean; cancelled?: boolean; allDay?: boolean } | null = null;
  for (const raw of lines) {
    if (raw === "BEGIN:VEVENT") {
      cur = {};
      continue;
    }
    if (raw === "END:VEVENT") {
      if (cur?.start != null && !cur.transparent && !cur.cancelled) {
        const end = cur.end ?? cur.start + (cur.allDay ? 86_400_000 : 0);
        if (end > cur.start && end > from && cur.start < to) out.push({ start: cur.start, end });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = raw.indexOf(":");
    if (idx < 0) continue;
    const head = raw.slice(0, idx);
    const value = raw.slice(idx + 1);
    const [name, ...paramParts] = head.split(";");
    const params: Record<string, string> = {};
    for (const p of paramParts) {
      const [k, v] = p.split("=");
      if (k && v) params[k.toUpperCase()] = v.replace(/^"|"$/g, "");
    }
    switch (name?.toUpperCase()) {
      case "DTSTART":
        cur.start = parseIcsDate(value, params);
        cur.allDay = params.VALUE === "DATE" || /^\d{8}$/.test(value.trim());
        break;
      case "DTEND":
        cur.end = parseIcsDate(value, params);
        break;
      case "TRANSP":
        cur.transparent = value.trim().toUpperCase() === "TRANSPARENT";
        break;
      case "STATUS":
        cur.cancelled = value.trim().toUpperCase() === "CANCELLED";
        break;
    }
  }
  return out;
}
