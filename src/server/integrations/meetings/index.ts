/**
 * Meeting providers.
 * - google_meet / ms_teams: created together with the calendar event of the
 *   host (requires a connected Google / Microsoft calendar as target).
 * - zoom: Zoom REST API with the host's Zoom OAuth connection.
 * - jitsi: a random room on the configured Jitsi server (no API needed).
 * - custom_video / phone / attendee_phone / in_person: static values.
 * A link is only ever shown when it was actually created.
 */
import { and, eq } from "drizzle-orm";
import { calendarConnections, eventTypes, type Booking } from "../../../database/schema";
import type { AppVariables, Env } from "../../env";
import { newToken } from "../../lib/ids";
import { getAccessToken } from "../calendar";
import { expectOk } from "../calendar/types";

type Db = AppVariables["db"];

export const LOCATION_LABELS: Record<string, string> = {
  google_meet: "Google Meet",
  ms_teams: "Microsoft Teams",
  zoom: "Zoom",
  jitsi: "Jitsi Meet",
  custom_video: "Video call",
  phone: "Phone call",
  attendee_phone: "Phone call (we call you)",
  in_person: "In person",
};

export async function createMeetingLink(env: Env, db: Db, booking: Booking, hostUserId: string): Promise<string | null> {
  if (booking.locationType === "jitsi") {
    const server = booking.locationValue && /^https:\/\/[a-z0-9.-]+\/?$/i.test(booking.locationValue) ? booking.locationValue.replace(/\/$/, "") : "https://meet.jit.si";
    return `${server}/OpenMeet-${newToken(12).replace(/[^A-Za-z0-9]/g, "")}`;
  }
  if (booking.locationType === "zoom") {
    const conn = await db
      .select()
      .from(calendarConnections)
      .where(and(eq(calendarConnections.userId, hostUserId), eq(calendarConnections.provider, "zoom"), eq(calendarConnections.status, "active")))
      .get();
    if (!conn) throw new Error("Host has no Zoom connection");
    const token = await getAccessToken(env, db, conn);
    const et = await db.select({ title: eventTypes.title }).from(eventTypes).where(eq(eventTypes.id, booking.eventTypeId)).get();
    const res = await expectOk(
      "zoom",
      await fetch("https://api.zoom.us/v2/users/me/meetings", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          topic: et?.title ?? booking.title,
          type: 2,
          start_time: new Date(booking.startAt).toISOString(),
          duration: Math.round((booking.endAt - booking.startAt) / 60000),
          settings: { join_before_host: false, waiting_room: true },
        }),
      }),
    );
    const json = (await res.json()) as { join_url?: string };
    return json.join_url ?? null;
  }
  return null;
}

export function describeLocation(type: string | null, value: string | null, meetingUrl: string | null): string {
  if (!type) return "";
  if (meetingUrl) return `${LOCATION_LABELS[type] ?? type}: ${meetingUrl}`;
  if (type === "custom_video" && value) return `Video call: ${value}`;
  if (type === "phone" && value) return `Phone: ${value}`;
  if (type === "attendee_phone" && value) return `We will call you at ${value}`;
  if (type === "in_person" && value) return `Address: ${value}`;
  if (type === "google_meet" || type === "ms_teams" || type === "zoom") return `${LOCATION_LABELS[type]} (link will be shared by the organizer)`;
  return LOCATION_LABELS[type] ?? type;
}
