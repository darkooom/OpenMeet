import { assertSafeOutboundUrl } from "../../security/ssrf";
import { parseIcsBusy } from "../../services/ics";
import type { CalendarAdapter } from "./types";

/**
 * Read-only subscription to an ICS feed (e.g. a "secret address" of any
 * calendar). Used only for conflict detection.
 */
export const icsFeedCalendar: CalendarAdapter = {
  provider: "ics",
  canWrite: false,
  async listCalendars(ctx) {
    return [{ externalId: "feed", name: ctx.credentials?.name || "ICS feed", primary: true, writable: false }];
  },
  async freeBusy(ctx, _ids, from, to) {
    const url = ctx.credentials?.url;
    if (!url) return [];
    const safe = assertSafeOutboundUrl(url.replace(/^webcal:/i, "https:"));
    const res = await ctx.fetch(safe.toString(), { redirect: "manual", headers: { accept: "text/calendar" } });
    if (!res.ok) throw new Error(`ICS feed returned ${res.status}`);
    const text = await res.text();
    if (text.length > 5_000_000) throw new Error("ICS feed too large");
    return parseIcsBusy(text, from, to);
  },
  async createEvent() {
    throw new Error("ICS feeds are read-only");
  },
  async updateEvent() {
    throw new Error("ICS feeds are read-only");
  },
  async deleteEvent() {
    /* read-only */
  },
};
