import type { CalendarAdapter, CalendarEventInput, ConnectionContext } from "./types";
import { expectOk } from "./types";

const API = "https://graph.microsoft.com/v1.0";

function body(ev: CalendarEventInput, includeOnlineMeeting: boolean) {
  const b: Record<string, unknown> = {
    subject: ev.title,
    body: { contentType: "text", content: ev.description },
    start: { dateTime: new Date(ev.start).toISOString().replace("Z", ""), timeZone: "UTC" },
    end: { dateTime: new Date(ev.end).toISOString().replace("Z", ""), timeZone: "UTC" },
    attendees: ev.attendees.map((a) => ({ emailAddress: { address: a.email, name: a.name }, type: "required" })),
    transactionId: ev.uid,
  };
  if (ev.location) b.location = { displayName: ev.location };
  if (includeOnlineMeeting && ev.conference === "ms_teams") {
    b.isOnlineMeeting = true;
    b.onlineMeetingProvider = "teamsForBusiness";
  }
  return b;
}

async function auth(ctx: ConnectionContext) {
  return { authorization: `Bearer ${await ctx.accessToken()}`, "content-type": "application/json" };
}

export const microsoftCalendar: CalendarAdapter = {
  provider: "microsoft",
  canWrite: true,

  async listCalendars(ctx) {
    const res = await expectOk("microsoft", await ctx.fetch(`${API}/me/calendars?$top=100`, { headers: await auth(ctx) }));
    const json = (await res.json()) as { value?: { id: string; name: string; isDefaultCalendar?: boolean; canEdit?: boolean }[] };
    return (json.value ?? []).map((c) => ({ externalId: c.id, name: c.name, primary: !!c.isDefaultCalendar, writable: c.canEdit !== false }));
  },

  async freeBusy(ctx, calendarIds, from, to) {
    // calendarView per selected calendar; expands recurring events server-side.
    const out: { start: number; end: number }[] = [];
    for (const id of calendarIds) {
      let url: string | null =
        `${API}/me/calendars/${encodeURIComponent(id)}/calendarView?startDateTime=${new Date(from).toISOString()}&endDateTime=${new Date(to).toISOString()}&$select=start,end,showAs,isCancelled&$top=250`;
      let pages = 0;
      while (url && pages < 10) {
        const res = await expectOk("microsoft", await ctx.fetch(url, { headers: { ...(await auth(ctx)), Prefer: 'outlook.timezone="UTC"' } }));
        const json = (await res.json()) as {
          value?: { start: { dateTime: string }; end: { dateTime: string }; showAs?: string; isCancelled?: boolean }[];
          "@odata.nextLink"?: string;
        };
        for (const e of json.value ?? []) {
          if (e.isCancelled || e.showAs === "free" || e.showAs === "workingElsewhere") continue;
          out.push({ start: Date.parse(`${e.start.dateTime}Z`), end: Date.parse(`${e.end.dateTime}Z`) });
        }
        url = json["@odata.nextLink"] ?? null;
        pages++;
      }
    }
    return out;
  },

  async createEvent(ctx, calendarId, ev) {
    const res = await expectOk(
      "microsoft",
      await ctx.fetch(`${API}/me/calendars/${encodeURIComponent(calendarId)}/events`, { method: "POST", headers: await auth(ctx), body: JSON.stringify(body(ev, true)) }),
    );
    const json = (await res.json()) as { id: string; onlineMeeting?: { joinUrl?: string } };
    return { id: json.id, meetingUrl: json.onlineMeeting?.joinUrl ?? null };
  },

  async updateEvent(ctx, _calendarId, eventId, ev) {
    const res = await expectOk(
      "microsoft",
      await ctx.fetch(`${API}/me/events/${encodeURIComponent(eventId)}`, { method: "PATCH", headers: await auth(ctx), body: JSON.stringify(body(ev, false)) }),
    );
    const json = (await res.json()) as { id: string; onlineMeeting?: { joinUrl?: string } };
    return { id: json.id, meetingUrl: json.onlineMeeting?.joinUrl ?? null };
  },

  async deleteEvent(ctx, _calendarId, eventId) {
    const res = await ctx.fetch(`${API}/me/events/${encodeURIComponent(eventId)}`, { method: "DELETE", headers: await auth(ctx) });
    if (res.status === 404) return;
    await expectOk("microsoft", res);
  },
};
