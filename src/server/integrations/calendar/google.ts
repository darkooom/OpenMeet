import type { CalendarAdapter, CalendarEventInput, ConnectionContext, CreatedEvent } from "./types";
import { expectOk } from "./types";

const API = "https://www.googleapis.com/calendar/v3";

function body(ev: CalendarEventInput, withConference: boolean) {
  const b: Record<string, unknown> = {
    summary: ev.title,
    description: ev.description,
    start: { dateTime: new Date(ev.start).toISOString(), timeZone: ev.timezone },
    end: { dateTime: new Date(ev.end).toISOString(), timeZone: ev.timezone },
    attendees: ev.attendees.map((a) => ({ email: a.email, displayName: a.name })),
    iCalUID: undefined,
    extendedProperties: { private: { openmeetUid: ev.uid } },
  };
  if (ev.location) b.location = ev.location;
  if (withConference && ev.conference === "google_meet") {
    b.conferenceData = { createRequest: { requestId: ev.uid.slice(0, 60), conferenceSolutionKey: { type: "hangoutsMeet" } } };
  }
  return b;
}

function meetLink(json: { hangoutLink?: string; conferenceData?: { entryPoints?: { entryPointType: string; uri: string }[] } }): string | null {
  return json.hangoutLink ?? json.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ?? null;
}

export const googleCalendar: CalendarAdapter = {
  provider: "google",
  canWrite: true,

  async listCalendars(ctx) {
    const res = await expectOk("google", await ctx.fetch(`${API}/users/me/calendarList?minAccessRole=reader&maxResults=250`, { headers: await auth(ctx) }));
    const json = (await res.json()) as { items?: { id: string; summary: string; primary?: boolean; accessRole: string }[] };
    return (json.items ?? []).map((c) => ({ externalId: c.id, name: c.summary, primary: !!c.primary, writable: c.accessRole === "owner" || c.accessRole === "writer" }));
  },

  async freeBusy(ctx, calendarIds, from, to) {
    if (calendarIds.length === 0) return [];
    const res = await expectOk(
      "google",
      await ctx.fetch(`${API}/freeBusy`, {
        method: "POST",
        headers: { ...(await auth(ctx)), "content-type": "application/json" },
        body: JSON.stringify({ timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), items: calendarIds.map((id) => ({ id })) }),
      }),
    );
    const json = (await res.json()) as { calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> };
    const out: { start: number; end: number }[] = [];
    for (const cal of Object.values(json.calendars ?? {})) {
      if (cal.errors?.length) throw new Error("Google free/busy returned calendar errors");
      for (const b of cal.busy ?? []) out.push({ start: Date.parse(b.start), end: Date.parse(b.end) });
    }
    return out;
  },

  async createEvent(ctx, calendarId, ev): Promise<CreatedEvent> {
    const res = await expectOk(
      "google",
      await ctx.fetch(`${API}/calendars/${encodeURIComponent(calendarId)}/events?conferenceDataVersion=1&sendUpdates=none`, {
        method: "POST",
        headers: { ...(await auth(ctx)), "content-type": "application/json" },
        body: JSON.stringify(body(ev, true)),
      }),
    );
    const json = (await res.json()) as { id: string; hangoutLink?: string };
    return { id: json.id, meetingUrl: meetLink(json) };
  },

  async updateEvent(ctx, calendarId, eventId, ev) {
    const res = await expectOk(
      "google",
      await ctx.fetch(`${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?conferenceDataVersion=1&sendUpdates=none`, {
        method: "PATCH",
        headers: { ...(await auth(ctx)), "content-type": "application/json" },
        body: JSON.stringify(body(ev, false)),
      }),
    );
    const json = (await res.json()) as { id: string; hangoutLink?: string };
    return { id: json.id, meetingUrl: meetLink(json) };
  },

  async deleteEvent(ctx, calendarId, eventId) {
    const res = await ctx.fetch(`${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, {
      method: "DELETE",
      headers: await auth(ctx),
    });
    if (res.status === 404 || res.status === 410) return; // already gone
    await expectOk("google", res);
  },
};

async function auth(ctx: ConnectionContext) {
  return { authorization: `Bearer ${await ctx.accessToken()}` };
}
