import { toZonedParts, zonedToUtc, addDays } from "../../shared/time";

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function browserLocale(): "en" | "de" {
  return navigator.language?.toLowerCase().startsWith("de") ? "de" : "en";
}

export function intlLocale(lang: string) {
  return lang === "de" ? "de-DE" : "en-GB";
}

export function fmtTime(ms: number, tz: string, lang = "en", h12 = false) {
  return new Intl.DateTimeFormat(intlLocale(lang), { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: h12 }).format(ms);
}

export function fmtDate(ms: number, tz: string, lang = "en", opts: Intl.DateTimeFormatOptions = { weekday: "long", day: "numeric", month: "long" }) {
  return new Intl.DateTimeFormat(intlLocale(lang), { timeZone: tz, ...opts }).format(ms);
}

export function fmtDateTime(ms: number, tz: string, lang = "en") {
  return new Intl.DateTimeFormat(intlLocale(lang), { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(ms);
}

export function fmtRange(start: number, end: number, tz: string, lang = "en") {
  return `${fmtTime(start, tz, lang)} – ${fmtTime(end, tz, lang)}`;
}

export function relativeDay(ms: number, tz: string): string {
  const d = toZonedParts(ms, tz).date;
  const today = toZonedParts(Date.now(), tz).date;
  if (d === today) return "Today";
  if (d === addDays(today, 1)) return "Tomorrow";
  return fmtDate(ms, tz, "en", { weekday: "short", day: "numeric", month: "short" });
}

export function startOfLocalDay(date: string, tz: string) {
  return zonedToUtc(date, 0, tz);
}

export function minutesLabel(min: number) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export const TIME_ZONES: string[] = (() => {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone");
    if (list && list.length > 0) return list.includes("UTC") ? list : ["UTC", ...list];
  } catch {
    /* ignore */
  }
  return ["UTC", "Europe/Berlin", "Europe/London", "Europe/Vienna", "Europe/Zurich", "Europe/Paris", "America/New_York", "America/Chicago", "America/Los_Angeles", "Asia/Tokyo", "Asia/Kolkata", "Australia/Sydney"];
})();

export const LOCATION_LABELS: Record<string, string> = {
  google_meet: "Google Meet",
  ms_teams: "Microsoft Teams",
  zoom: "Zoom",
  jitsi: "Jitsi Meet",
  custom_video: "Video link",
  phone: "Phone call (you call)",
  attendee_phone: "Phone call (we call you)",
  in_person: "In person",
};
