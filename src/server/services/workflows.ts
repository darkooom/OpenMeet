/**
 * Workflow execution. A run executes its steps in order; a "delay" step
 * re-enqueues the remaining steps as a new job, so long delays survive
 * Worker restarts. Every step result is appended to workflow_runs.log.
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../database/schema";
import { bookingAttendees, bookings, eventTypes, users, workflowRuns, workflows } from "../../database/schema";
import type { Env } from "../env";
import { newId } from "../lib/ids";
import { parseJson } from "../lib/json";
import { decryptString } from "../security/crypto";
import { redactString } from "../security/redact";
import { safeFetch } from "../security/ssrf";
import type { WorkflowStep } from "../../shared/schemas";
import { MINUTE } from "../../shared/time";
import { bookingWebhookPayload, deliverSigned } from "./webhooks";
import { enqueue } from "./jobs";
import { formatRange, simpleEmail } from "./notifications";
import { queueRawEmail } from "./mailer";
import { getConfig, linkBaseUrl } from "./settings";

export interface WorkflowJobPayload {
  workflowId: string;
  bookingId: string;
  event: string;
  stepIndex: number;
  runId?: string;
  expectedStart?: number;
}

export async function templateVars(env: Env, bookingId: string): Promise<Record<string, string>> {
  const db = drizzle(env.DB, { schema });
  const cfg = await getConfig(db);
  const baseUrl = linkBaseUrl(cfg, env);
  const b = await db.select().from(bookings).where(eq(bookings.id, bookingId)).get();
  if (!b) return {};
  const et = await db.select().from(eventTypes).where(eq(eventTypes.id, b.eventTypeId)).get();
  const org = await db.select().from(users).where(eq(users.id, b.organizerUserId)).get();
  const att = await db.select().from(bookingAttendees).where(eq(bookingAttendees.bookingId, b.id)).get();
  const vars: Record<string, string> = {
    "event.title": et?.title ?? b.title,
    "booking.id": b.id,
    "booking.status": b.status,
    "booking.start_iso": new Date(b.startAt).toISOString(),
    "booking.end_iso": new Date(b.endAt).toISOString(),
    "booking.time": formatRange(b.startAt, b.endAt, att?.timezone ?? org?.timezone ?? "UTC", att?.locale === "de" ? "de" : "en"),
    "booking.cancel_reason": b.cancelReason ?? "",
    "meeting.url": b.meetingUrl ?? b.locationValue ?? "",
    "organizer.name": org?.name ?? "",
    "organizer.email": org?.email ?? "",
    "attendee.name": att?.name ?? "",
    "attendee.email": att?.email ?? "",
  };
  if (att?.manageTokenEnc && baseUrl) {
    const token = await decryptString(env.ENCRYPTION_KEY, att.manageTokenEnc, "manage-token");
    vars["booking.reschedule_url"] = `${baseUrl}/reschedule/${token}`;
    vars["booking.cancel_url"] = `${baseUrl}/cancel/${token}`;
  }
  return vars;
}

export function interpolate(template: string, vars: Record<string, string>, escape: (s: string) => string = (s) => s): string {
  return template.replace(/\{\{\s*([a-z_.]+)\s*\}\}/gi, (_, key: string) => escape(vars[key] ?? ""));
}

async function appendLog(env: Env, runId: string, entry: Record<string, unknown>, status?: "running" | "succeeded" | "failed") {
  const db = drizzle(env.DB, { schema });
  const run = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get();
  if (!run) return;
  const log = parseJson<unknown[]>(run.log, []);
  log.push({ at: new Date().toISOString(), ...entry });
  await db
    .update(workflowRuns)
    .set({ log: JSON.stringify(log.slice(-100)), status: status ?? run.status, finishedAt: status && status !== "running" ? Date.now() : run.finishedAt })
    .where(eq(workflowRuns.id, runId));
}

export async function runWorkflowStep(env: Env, p: WorkflowJobPayload): Promise<void> {
  const db = drizzle(env.DB, { schema });
  const wf = await db.select().from(workflows).where(eq(workflows.id, p.workflowId)).get();
  if (!wf || !wf.isActive) return;
  const booking = await db.select().from(bookings).where(eq(bookings.id, p.bookingId)).get();
  if (!booking) return;
  // Time based triggers are skipped if the booking moved or was cancelled meanwhile.
  if (p.expectedStart != null && (booking.startAt !== p.expectedStart || booking.status === "cancelled" || booking.status === "rejected")) return;
  let runId = p.runId;
  if (!runId) {
    runId = newId();
    await db.insert(workflowRuns).values({ id: runId, workflowId: wf.id, bookingId: booking.id, status: "running", log: "[]", createdAt: Date.now() });
  }
  const steps = parseJson<WorkflowStep[]>(wf.steps, []);
  const vars = await templateVars(env, booking.id);
  for (let i = p.stepIndex; i < steps.length; i++) {
    const step = steps[i]!;
    try {
      if (step.type === "delay") {
        await enqueue(env.DB, "workflow.run", { ...p, runId, stepIndex: i + 1 }, { runAt: Date.now() + step.minutes * MINUTE, dedupeKey: `wf:${runId}:${i + 1}` });
        await appendLog(env, runId, { step: i, type: "delay", minutes: step.minutes });
        return;
      }
      await executeStep(env, step, vars, p.event, booking.id, runId);
      await appendLog(env, runId, { step: i, type: step.type, ok: true });
    } catch (err) {
      const msg = redactString(err instanceof Error ? err.message : String(err));
      await appendLog(env, runId, { step: i, type: step.type, ok: false, error: msg }, "failed");
      throw err;
    }
  }
  await appendLog(env, runId, { done: true }, "succeeded");
}

async function executeStep(env: Env, step: WorkflowStep, vars: Record<string, string>, event: string, bookingId: string, runId: string): Promise<void> {
  const db = drizzle(env.DB, { schema });
  switch (step.type) {
    case "send_email": {
      const to = step.to === "attendee" ? vars["attendee.email"] : step.to === "organizer" ? vars["organizer.email"] : step.customTo;
      if (!to) throw new Error("No recipient");
      const cfg = await getConfig(db);
      const subject = interpolate(step.subject, vars).slice(0, 300);
      const bodyText = interpolate(step.body, vars);
      const { html, text } = simpleEmail(cfg.productName, subject, bodyText.split(/\n{2,}/));
      await queueRawEmail(env, to, subject, { html, text }, "workflow");
      return;
    }
    case "webhook": {
      const payload = await bookingWebhookPayload(env, event, bookingId);
      const res = await deliverSigned(env, { url: step.url, secret: step.secret ?? null, event, payload, workflowRunId: runId });
      if (!res.ok) throw new Error(res.error ?? "Webhook failed");
      return;
    }
    case "slack":
    case "ms_teams": {
      const text = interpolate(step.text, vars).slice(0, 3000);
      const body = step.type === "slack" ? { text } : { text };
      const res = await safeFetch(step.webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (res.status < 200 || res.status >= 300) throw new Error(`${step.type} responded ${res.status}`);
      return;
    }
    case "http": {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(step.headers ?? {})) {
        if (/^(host|content-length|cookie)$/i.test(k)) continue;
        headers[k] = interpolate(v, vars);
      }
      const body = step.body && step.method !== "GET" ? interpolate(step.body, vars, (s) => JSON.stringify(s).slice(1, -1)) : undefined;
      const res = await safeFetch(step.url, { method: step.method, headers, body });
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
      return;
    }
    case "delay":
      return;
  }
}
