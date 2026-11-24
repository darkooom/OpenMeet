/**
 * Fan-out of booking lifecycle events into individual, idempotent jobs:
 * calendar sync, e-mails, reminders, workflows and webhooks.
 */
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../database/schema";
import { bookingAttendees, bookingHosts, bookings, webhooks, workflows } from "../../database/schema";
import type { Env } from "../env";
import { parseJson } from "../lib/json";
import { HOUR, MINUTE } from "../../shared/time";
import { syncBookingCalendars } from "../integrations/calendar";
import { enqueueStatement, type JobRow } from "./jobs";
import type { BookingEvent } from "./booking";
import type { BookingTemplate, EmailJobPayload } from "./notifications";

interface EventPayload {
  event: BookingEvent;
  bookingId: string;
  attendeeId?: string | null;
  partial?: boolean;
  reason?: string | null;
  previous?: { startAt: number; endAt: number };
  by?: string;
}

export async function handleBookingEvent(env: Env, p: EventPayload, job: JobRow): Promise<void> {
  const db = drizzle(env.DB, { schema });
  const b = await db.select().from(bookings).where(eq(bookings.id, p.bookingId)).get();
  if (!b) return;
  const attendees = await db.select().from(bookingAttendees).where(eq(bookingAttendees.bookingId, b.id));
  const hostIds = (await db.select({ u: bookingHosts.userId }).from(bookingHosts).where(eq(bookingHosts.bookingId, b.id))).map((h) => h.u);
  const activeAttendees = attendees.filter((a) => a.status === "active");
  const targetAttendees = p.attendeeId ? attendees.filter((a) => a.id === p.attendeeId) : activeAttendees;
  const stmts: D1PreparedStatement[] = [];
  const key = (suffix: string) => `evt:${job.id}:${suffix}`;
  const email = (template: BookingTemplate, extra: Partial<EmailJobPayload> & { attendeeId?: string; hostUserId?: string }, runAt?: number, dedupe?: string) =>
    stmts.push(
      enqueueStatement(env.DB, "email.booking", { template, bookingId: b.id, reason: p.reason ?? null, ...extra } satisfies EmailJobPayload, {
        runAt,
        dedupeKey: dedupe ?? key(`${template}:${extra.attendeeId ?? extra.hostUserId ?? ""}`),
      }),
    );
  const scheduleReminders = (attendeeIds: string[]) => {
    const now = Date.now();
    for (const id of attendeeIds) {
      if (b.startAt - 24 * HOUR > now + HOUR) email("reminder_24h", { attendeeId: id, expectedStart: b.startAt }, b.startAt - 24 * HOUR, `rem24:${id}:${b.startAt}`);
      if (b.startAt - HOUR > now + 5 * MINUTE) email("reminder_1h", { attendeeId: id, expectedStart: b.startAt }, b.startAt - HOUR, `rem1:${id}:${b.startAt}`);
    }
  };

  const syncCalendars = async (action: "upsert" | "delete") => {
    const res = await syncBookingCalendars(env, b.id, action).catch((err: unknown) => ({ errors: [String(err)] }));
    if (res.errors.length > 0) stmts.push(enqueueStatement(env.DB, "calendar.sync", { bookingId: b.id, action }, { dedupeKey: key(`cal:${action}`), runAt: Date.now() + 60_000 }));
  };

  switch (p.event) {
    case "booking.created": {
      if (b.status === "confirmed") {
        await syncCalendars("upsert");
        for (const a of targetAttendees) email("booking_confirmed_attendee", { attendeeId: a.id });
        for (const h of hostIds) email("booking_new_organizer", { hostUserId: h, attendeeId: targetAttendees[0]?.id });
        scheduleReminders(targetAttendees.map((a) => a.id));
      } else {
        for (const a of targetAttendees) email("booking_pending_attendee", { attendeeId: a.id });
        for (const h of hostIds) email("booking_request_organizer", { hostUserId: h, attendeeId: targetAttendees[0]?.id });
      }
      break;
    }
    case "booking.confirmed": {
      await syncCalendars("upsert");
      for (const a of activeAttendees) email("booking_confirmed_attendee", { attendeeId: a.id });
      scheduleReminders(activeAttendees.map((a) => a.id));
      break;
    }
    case "booking.rejected": {
      for (const a of activeAttendees) email("booking_rejected_attendee", { attendeeId: a.id });
      break;
    }
    case "booking.cancelled": {
      await syncCalendars(p.partial ? "upsert" : "delete");
      const recipients = p.partial ? targetAttendees : attendees.filter((a) => a.status === "active" || a.id === p.attendeeId);
      for (const a of recipients) email("booking_cancelled_attendee", { attendeeId: a.id });
      for (const h of hostIds) email("booking_cancelled_organizer", { hostUserId: h, attendeeId: recipients[0]?.id });
      break;
    }
    case "booking.rescheduled": {
      await syncCalendars("upsert");
      for (const a of activeAttendees) email("booking_rescheduled_attendee", { attendeeId: a.id, previousStart: p.previous?.startAt });
      for (const h of hostIds) email("booking_rescheduled_organizer", { hostUserId: h, attendeeId: activeAttendees[0]?.id, previousStart: p.previous?.startAt });
      scheduleReminders(activeAttendees.map((a) => a.id));
      break;
    }
    case "booking.no_show": {
      for (const a of p.attendeeId ? targetAttendees : activeAttendees) email("no_show_followup", { attendeeId: a.id });
      break;
    }
  }

  // Workflows of the hosts.
  if (hostIds.length > 0) {
    const wfs = await db.select().from(workflows).where(and(inArray(workflows.ownerUserId, hostIds), eq(workflows.isActive, true)));
    for (const wf of wfs) {
      const filter = parseJson<string[] | null>(wf.eventTypeIds, null);
      if (filter && filter.length > 0 && !filter.includes(b.eventTypeId)) continue;
      const direct = wf.trigger === p.event || (wf.trigger === "booking.created" && p.event === "booking.created");
      if (direct) {
        stmts.push(enqueueStatement(env.DB, "workflow.run", { workflowId: wf.id, bookingId: b.id, event: p.event, stepIndex: 0 }, { dedupeKey: key(`wf:${wf.id}`) }));
      }
      // Time based triggers are (re)scheduled whenever a booking becomes active or moves.
      const activates = (p.event === "booking.created" && b.status === "confirmed") || p.event === "booking.confirmed" || p.event === "booking.rescheduled";
      if (activates && (wf.trigger === "meeting.starting" || wf.trigger === "meeting.completed")) {
        const runAt = wf.trigger === "meeting.starting" ? b.startAt - wf.offsetMinutes * MINUTE : b.endAt + wf.offsetMinutes * MINUTE;
        if (runAt > Date.now()) {
          stmts.push(
            enqueueStatement(env.DB, "workflow.run", { workflowId: wf.id, bookingId: b.id, event: wf.trigger, stepIndex: 0, expectedStart: b.startAt }, { runAt, dedupeKey: `wft:${wf.id}:${b.id}:${b.startAt}` }),
          );
        }
      }
    }
    // Webhook subscriptions of the hosts.
    const hooks = await db.select().from(webhooks).where(and(inArray(webhooks.ownerUserId, hostIds), eq(webhooks.isActive, true)));
    const publicEvent = p.event === "booking.rejected" ? "booking.cancelled" : p.event;
    for (const h of hooks) {
      if (!parseJson<string[]>(h.events, []).includes(publicEvent)) continue;
      stmts.push(enqueueStatement(env.DB, "webhook.deliver", { webhookId: h.id, event: publicEvent, bookingId: b.id }, { dedupeKey: key(`wh:${h.id}`), maxAttempts: 8 }));
    }
  }

  if (stmts.length > 0) await env.DB.batch(stmts);
}
