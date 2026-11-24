import { assertSafeOutboundUrl } from "../../security/ssrf";
import { buildIcs, parseIcsBusy } from "../../services/ics";
import type { CalendarAdapter, ConnectionContext } from "./types";
import { expectOk } from "./types";

/**
 * CalDAV adapter (RFC 4791) using HTTP Basic auth (app passwords).
 * The connection stores the URL of ONE calendar collection, e.g.
 *   https://caldav.fastmail.com/dav/calendars/user/me@example.com/Default/
 * Discovery (principal → calendar-home-set) is intentionally not automated.
 */
function base(ctx: ConnectionContext): string {
  const url = ctx.credentials?.url;
  if (!url) throw new Error("CalDAV URL missing");
  const u = assertSafeOutboundUrl(url);
  return u.toString().endsWith("/") ? u.toString() : `${u.toString()}/`;
}

function headers(ctx: ConnectionContext, extra: Record<string, string> = {}) {
  const user = ctx.credentials?.username ?? "";
  const pass = ctx.credentials?.password ?? "";
  return { authorization: `Basic ${btoa(`${user}:${pass}`)}`, ...extra };
}

function fmt(ms: number) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export const caldavCalendar: CalendarAdapter = {
  provider: "caldav",
  canWrite: true,

  async listCalendars(ctx) {
    const url = base(ctx);
    const res = await ctx.fetch(url, {
      method: "PROPFIND",
      redirect: "manual",
      headers: headers(ctx, { depth: "0", "content-type": "application/xml" }),
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>`,
    });
    await expectOk("caldav", res);
    const xml = await res.text();
    const name = /<[a-z]*:?displayname>([^<]*)</i.exec(xml)?.[1] || "CalDAV calendar";
    return [{ externalId: url, name, primary: true, writable: true }];
  },

  async freeBusy(ctx, _ids, from, to) {
    const url = base(ctx);
    const res = await ctx.fetch(url, {
      method: "REPORT",
      redirect: "manual",
      headers: headers(ctx, { depth: "1", "content-type": "application/xml" }),
      body: `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-data><c:expand start="${fmt(from)}" end="${fmt(to)}"/></c:calendar-data></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${fmt(from)}" end="${fmt(to)}"/></c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`,
    });
    await expectOk("caldav", res);
    const xml = await res.text();
    const decoded = xml.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&#13;/g, "");
    return parseIcsBusy(decoded, from, to);
  },

  async createEvent(ctx, _calendarId, ev) {
    const id = `${ev.uid}.ics`;
    const ics = buildIcs([{ uid: ev.uid, start: ev.start, end: ev.end, summary: ev.title, description: ev.description, location: ev.location ?? undefined, attendees: ev.attendees }]);
    const res = await ctx.fetch(`${base(ctx)}${encodeURIComponent(id)}`, {
      method: "PUT",
      redirect: "manual",
      headers: headers(ctx, { "content-type": "text/calendar; charset=utf-8" }),
      body: ics,
    });
    await expectOk("caldav", res);
    return { id, meetingUrl: null };
  },

  async updateEvent(ctx, calendarId, eventId, ev) {
    const ics = buildIcs([{ uid: ev.uid, sequence: 1, start: ev.start, end: ev.end, summary: ev.title, description: ev.description, location: ev.location ?? undefined, attendees: ev.attendees }]);
    const res = await ctx.fetch(`${base(ctx)}${encodeURIComponent(eventId)}`, {
      method: "PUT",
      redirect: "manual",
      headers: headers(ctx, { "content-type": "text/calendar; charset=utf-8" }),
      body: ics,
    });
    await expectOk("caldav", res);
    return { id: eventId, meetingUrl: null };
  },

  async deleteEvent(ctx, _calendarId, eventId) {
    const res = await ctx.fetch(`${base(ctx)}${encodeURIComponent(eventId)}`, { method: "DELETE", redirect: "manual", headers: headers(ctx) });
    if (res.status === 404) return;
    await expectOk("caldav", res);
  },
};
