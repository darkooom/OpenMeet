import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../database/schema";
import { bookings } from "../../database/schema";
import type { Env } from "../env";
import { syncBookingCalendars } from "../integrations/calendar";
import { handleBookingEvent } from "./events";
import type { JobHandler } from "./jobs";
import { handleBookingEmail, handleRawEmail, type EmailJobPayload, type RawEmailPayload } from "./notifications";
import { handleWebhookJob } from "./webhooks";
import { runWorkflowStep, type WorkflowJobPayload } from "./workflows";

export const JOB_HANDLERS: Record<string, JobHandler> = {
  "booking.event": (env, p, job) => handleBookingEvent(env, p as never, job),
  "email.booking": async (env: Env, p, job) => {
    const payload = p as unknown as EmailJobPayload & { expectedStart?: number };
    if (payload.expectedStart != null) {
      const db = drizzle(env.DB, { schema });
      const b = await db.select({ startAt: bookings.startAt, status: bookings.status }).from(bookings).where(eq(bookings.id, payload.bookingId)).get();
      if (!b || b.startAt !== payload.expectedStart || b.status !== "confirmed") return; // stale reminder
    }
    await handleBookingEmail(env, payload, job.id);
  },
  "email.raw": (env, p, job) => handleRawEmail(env, p as unknown as RawEmailPayload, job.id),
  "webhook.deliver": (env, p) => handleWebhookJob(env, p as never),
  "workflow.run": (env, p) => runWorkflowStep(env, p as unknown as WorkflowJobPayload),
  "calendar.sync": async (env, p) => {
    const { errors } = await syncBookingCalendars(env, String(p.bookingId), p.action === "delete" ? "delete" : "upsert");
    if (errors.length > 0) throw new Error(errors.join("; "));
  },
};
