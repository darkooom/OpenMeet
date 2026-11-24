/**
 * E-mail templates (en/de) and the e-mail job handler.
 * Templates are rendered at send time, so links with manage tokens never sit
 * in the job queue in plain text.
 */
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../database/schema";
import { bookingAttendees, bookingHosts, bookings, emailLog, eventTypes, users } from "../../database/schema";
import type { Env } from "../env";
import { newId } from "../lib/ids";
import { EmailProviderError, sendEmail, type EmailAttachment } from "../integrations/email";
import { describeLocation } from "../integrations/meetings";
import { decryptString } from "../security/crypto";
import { redactString } from "../security/redact";
import { buildIcs } from "./ics";
import { PermanentJobError } from "./jobs";
import { getConfig, getCredentials, linkBaseUrl } from "./settings";

export type BookingTemplate =
  | "booking_confirmed_attendee"
  | "booking_pending_attendee"
  | "booking_new_organizer"
  | "booking_request_organizer"
  | "booking_cancelled_attendee"
  | "booking_cancelled_organizer"
  | "booking_rescheduled_attendee"
  | "booking_rescheduled_organizer"
  | "booking_rejected_attendee"
  | "reminder_24h"
  | "reminder_1h"
  | "no_show_followup";

type Lang = "en" | "de";

const STRINGS: Record<Lang, Record<string, string>> = {
  en: {
    booking_confirmed_attendee: "Confirmed: {event} with {organizer}",
    booking_pending_attendee: "Request received: {event} with {organizer}",
    booking_new_organizer: "New booking: {event} with {attendee}",
    booking_request_organizer: "Booking request: {event} with {attendee} – action required",
    booking_cancelled_attendee: "Cancelled: {event} with {organizer}",
    booking_cancelled_organizer: "Cancelled: {event} with {attendee}",
    booking_rescheduled_attendee: "Rescheduled: {event} with {organizer}",
    booking_rescheduled_organizer: "Rescheduled: {event} with {attendee}",
    booking_rejected_attendee: "Declined: {event} with {organizer}",
    reminder_24h: "Reminder: {event} tomorrow",
    reminder_1h: "Starting soon: {event}",
    no_show_followup: "We missed you – {event}",
    intro_confirmed: "Your meeting is confirmed.",
    intro_pending: "Your request was sent. You will receive another e-mail once it has been confirmed.",
    intro_new: "A new meeting has been booked.",
    intro_request: "A new booking request needs your confirmation.",
    intro_cancelled: "This meeting has been cancelled.",
    intro_rescheduled: "This meeting has been moved to a new time.",
    intro_rejected: "Unfortunately this request was declined.",
    intro_reminder: "This is a friendly reminder about your upcoming meeting.",
    intro_noshow: "It looks like we missed each other. You are welcome to book a new time.",
    when: "When",
    where: "Where",
    who: "Who",
    reason: "Reason",
    previous: "Previously",
    reschedule: "Reschedule",
    cancel: "Cancel",
    open_dashboard: "Open in OpenMeet",
    book_again: "Book a new time",
    footer: "Sent by {product}.",
  },
  de: {
    booking_confirmed_attendee: "Bestätigt: {event} mit {organizer}",
    booking_pending_attendee: "Anfrage erhalten: {event} mit {organizer}",
    booking_new_organizer: "Neue Buchung: {event} mit {attendee}",
    booking_request_organizer: "Buchungsanfrage: {event} mit {attendee} – Bestätigung erforderlich",
    booking_cancelled_attendee: "Abgesagt: {event} mit {organizer}",
    booking_cancelled_organizer: "Abgesagt: {event} mit {attendee}",
    booking_rescheduled_attendee: "Verschoben: {event} mit {organizer}",
    booking_rescheduled_organizer: "Verschoben: {event} mit {attendee}",
    booking_rejected_attendee: "Abgelehnt: {event} mit {organizer}",
    reminder_24h: "Erinnerung: {event} morgen",
    reminder_1h: "Gleich geht es los: {event}",
    no_show_followup: "Wir haben uns verpasst – {event}",
    intro_confirmed: "Ihr Termin ist bestätigt.",
    intro_pending: "Ihre Anfrage wurde gesendet. Sie erhalten eine weitere E-Mail, sobald sie bestätigt wurde.",
    intro_new: "Ein neuer Termin wurde gebucht.",
    intro_request: "Eine neue Buchungsanfrage wartet auf Ihre Bestätigung.",
    intro_cancelled: "Dieser Termin wurde abgesagt.",
    intro_rescheduled: "Dieser Termin wurde verschoben.",
    intro_rejected: "Diese Anfrage wurde leider abgelehnt.",
    intro_reminder: "Eine freundliche Erinnerung an Ihren bevorstehenden Termin.",
    intro_noshow: "Leider haben wir uns verpasst. Gerne können Sie einen neuen Termin buchen.",
    when: "Wann",
    where: "Wo",
    who: "Wer",
    reason: "Grund",
    previous: "Vorher",
    reschedule: "Umbuchen",
    cancel: "Absagen",
    open_dashboard: "In OpenMeet öffnen",
    book_again: "Neuen Termin buchen",
    footer: "Gesendet von {product}.",
  },
};

function t(lang: Lang, key: string, vars: Record<string, string> = {}): string {
  const s = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function formatRange(start: number, end: number, tz: string, lang: Lang): string {
  const locale = lang === "de" ? "de-DE" : "en-GB";
  const day = new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(start);
  const time = new Intl.DateTimeFormat(locale, { timeZone: tz, hour: "2-digit", minute: "2-digit" });
  return `${day}, ${time.format(start)} – ${time.format(end)} (${tz})`;
}

export interface RenderInput {
  lang: Lang;
  product: string;
  subjectKey: string;
  introKey: string;
  vars: Record<string, string>;
  rows: [string, string][];
  buttons: { label: string; url: string }[];
}

export function renderEmail(r: RenderInput): { subject: string; html: string; text: string } {
  const subject = t(r.lang, r.subjectKey, r.vars);
  const intro = t(r.lang, r.introKey, r.vars);
  const rowsHtml = r.rows
    .map(([k, v]) => `<tr><td style="padding:6px 16px 6px 0;color:#6b7280;vertical-align:top;white-space:nowrap">${escapeHtml(k)}</td><td style="padding:6px 0;color:#111827">${escapeHtml(v).replace(/\n/g, "<br>")}</td></tr>`)
    .join("");
  const buttonsHtml = r.buttons
    .map((b) => `<a href="${escapeHtml(b.url)}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 16px;border-radius:8px;background:#111827;color:#ffffff;text-decoration:none;font-weight:600">${escapeHtml(b.label)}</a>`)
    .join("");
  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px">
<tr><td style="padding:28px 28px 8px"><h1 style="margin:0 0 12px;font-size:18px;color:#111827">${escapeHtml(subject)}</h1><p style="margin:0;color:#374151;font-size:14px;line-height:1.6">${escapeHtml(intro)}</p></td></tr>
<tr><td style="padding:16px 28px"><table role="presentation" style="font-size:14px;line-height:1.5">${rowsHtml}</table></td></tr>
<tr><td style="padding:8px 28px 24px">${buttonsHtml}</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #f0f1f3;color:#9ca3af;font-size:12px">${escapeHtml(t(r.lang, "footer", { product: r.product }))}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [subject, "", intro, "", ...r.rows.map(([k, v]) => `${k}: ${v}`), "", ...r.buttons.map((b) => `${b.label}: ${b.url}`), "", t(r.lang, "footer", { product: r.product })].join("\n");
  return { subject, html, text };
}

function base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const TEMPLATE_INTRO: Record<BookingTemplate, string> = {
  booking_confirmed_attendee: "intro_confirmed",
  booking_pending_attendee: "intro_pending",
  booking_new_organizer: "intro_new",
  booking_request_organizer: "intro_request",
  booking_cancelled_attendee: "intro_cancelled",
  booking_cancelled_organizer: "intro_cancelled",
  booking_rescheduled_attendee: "intro_rescheduled",
  booking_rescheduled_organizer: "intro_rescheduled",
  booking_rejected_attendee: "intro_rejected",
  reminder_24h: "intro_reminder",
  reminder_1h: "intro_reminder",
  no_show_followup: "intro_noshow",
};

export interface EmailJobPayload {
  template: BookingTemplate;
  bookingId: string;
  /** attendee recipient (attendee templates) */
  attendeeId?: string;
  /** organizer / host recipient (organizer templates) */
  hostUserId?: string;
  reason?: string | null;
  previousStart?: number;
  baseUrl?: string;
  /** reminders: skip when the booking has moved */
  expectedStart?: number;
}

async function logEmail(env: Env, entry: Omit<typeof emailLog.$inferInsert, "id" | "createdAt">) {
  const db = drizzle(env.DB, { schema });
  await db.insert(emailLog).values({ id: newId(), createdAt: Date.now(), ...entry });
}

/** Job handler for "email.booking". */
export async function handleBookingEmail(env: Env, payload: EmailJobPayload, jobId: string): Promise<void> {
  const db = drizzle(env.DB, { schema });
  const cfg = await getConfig(db);
  const baseUrl = linkBaseUrl(cfg, env) || (payload.baseUrl ?? "");
  const b = await db.select().from(bookings).where(eq(bookings.id, payload.bookingId)).get();
  if (!b) return;
  const et = await db.select().from(eventTypes).where(eq(eventTypes.id, b.eventTypeId)).get();
  const hosts = await db.select({ id: users.id, name: users.name, email: users.email, locale: users.locale, timezone: users.timezone }).from(bookingHosts).innerJoin(users, eq(users.id, bookingHosts.userId)).where(eq(bookingHosts.bookingId, b.id));
  const attendees = await db.select().from(bookingAttendees).where(eq(bookingAttendees.bookingId, b.id));
  const organizer = hosts.find((h) => h.id === b.organizerUserId) ?? hosts[0];
  const isAttendeeMail = payload.attendeeId != null && !payload.template.endsWith("_organizer");
  const attendee = attendees.find((a) => a.id === payload.attendeeId) ?? attendees.find((a) => a.status === "active") ?? attendees[0];
  const host = hosts.find((h) => h.id === payload.hostUserId) ?? organizer;
  if (!attendee || !organizer || !host) return;

  const recipient = isAttendeeMail ? { email: attendee.email, name: attendee.name } : { email: host.email, name: host.name };
  const lang: Lang = ((isAttendeeMail ? attendee.locale : host.locale) ?? cfg.defaultLocale) === "de" ? "de" : "en";
  const tz = isAttendeeMail ? attendee.timezone : host.timezone;
  const eventTitle = et?.title ?? b.title;
  const vars = { event: eventTitle, organizer: organizer.name, attendee: attendee.name, product: cfg.productName };
  const rows: [string, string][] = [[t(lang, "when"), formatRange(b.startAt, b.endAt, tz, lang)]];
  if (payload.previousStart) rows.push([t(lang, "previous"), formatRange(payload.previousStart, payload.previousStart + (b.endAt - b.startAt), tz, lang)]);
  const where = describeLocation(b.locationType, b.locationValue, b.meetingUrl);
  if (where) rows.push([t(lang, "where"), where]);
  rows.push([t(lang, "who"), [...hosts.map((h) => h.name), ...attendees.filter((a) => a.status === "active").map((a) => `${a.name} <${a.email}>`)].join("\n")]);
  if (payload.reason) rows.push([t(lang, "reason"), payload.reason]);
  if (!isAttendeeMail && attendee.answers && attendee.answers !== "{}") {
    const answers = JSON.parse(attendee.answers) as Record<string, unknown>;
    const questions = et ? (JSON.parse(et.questions) as { id: string; label: string }[]) : [];
    for (const [k, v] of Object.entries(answers)) rows.push([questions.find((q) => q.id === k)?.label ?? k, Array.isArray(v) ? v.join(", ") : String(v)]);
  }

  const buttons: { label: string; url: string }[] = [];
  const active = b.status === "confirmed" || b.status === "pending";
  if (isAttendeeMail && active && attendee.manageTokenEnc && baseUrl && payload.template !== "no_show_followup") {
    const token = await decryptString(env.ENCRYPTION_KEY, attendee.manageTokenEnc, "manage-token");
    if (et?.kind !== "group") buttons.push({ label: t(lang, "reschedule"), url: `${baseUrl}/reschedule/${token}` });
    buttons.push({ label: t(lang, "cancel"), url: `${baseUrl}/cancel/${token}` });
  }
  if (!isAttendeeMail && baseUrl) buttons.push({ label: t(lang, "open_dashboard"), url: `${baseUrl}/app/bookings/${b.id}` });
  if (payload.template === "no_show_followup" && baseUrl && et?.ownerUserId) {
    const owner = await db.select({ username: users.username }).from(users).where(eq(users.id, et.ownerUserId)).get();
    if (owner) buttons.push({ label: t(lang, "book_again"), url: `${baseUrl}/u/${owner.username}/${et.slug}` });
  }

  const rendered = renderEmail({ lang, product: cfg.productName, subjectKey: payload.template, introKey: TEMPLATE_INTRO[payload.template], vars, rows, buttons });
  const attachments: EmailAttachment[] = [];
  const withIcs = ["booking_confirmed_attendee", "booking_rescheduled_attendee", "booking_new_organizer", "booking_rescheduled_organizer", "booking_cancelled_attendee", "booking_cancelled_organizer"].includes(payload.template);
  if (withIcs) {
    const cancelled = payload.template.startsWith("booking_cancelled");
    const ics = buildIcs(
      [
        {
          uid: `${b.id}@openmeet`,
          sequence: Math.floor((b.updatedAt - b.createdAt) / 1000),
          start: b.startAt,
          end: b.endAt,
          summary: `${eventTitle} (${isAttendeeMail ? organizer.name : attendee.name})`,
          description: where,
          location: b.meetingUrl ?? b.locationValue ?? undefined,
          organizer: { name: organizer.name, email: organizer.email },
          attendees: attendees.filter((a) => a.status === "active").map((a) => ({ name: a.name, email: a.email })),
          status: cancelled ? "CANCELLED" : "CONFIRMED",
        },
      ],
      { method: cancelled ? "CANCEL" : "REQUEST" },
    );
    attachments.push({ filename: "invite.ics", contentType: "text/calendar", content: base64(ics) });
  }

  const creds = await getCredentials(db, env, "email");
  if (!creds) {
    await logEmail(env, { jobId, bookingId: b.id, toEmail: recipient.email, subject: rendered.subject, template: payload.template, provider: null, status: "skipped", error: "No e-mail provider configured" });
    return;
  }
  try {
    const res = await sendEmail(creds, { to: recipient, ...rendered, attachments, idempotencyKey: `${jobId}`, replyTo: isAttendeeMail ? organizer.email : attendee.email });
    await logEmail(env, { jobId, bookingId: b.id, toEmail: recipient.email, subject: rendered.subject, template: payload.template, provider: res.provider, status: "sent", providerMessageId: res.messageId });
  } catch (err) {
    const msg = redactString(err instanceof Error ? err.message : String(err));
    await logEmail(env, { jobId, bookingId: b.id, toEmail: recipient.email, subject: rendered.subject, template: payload.template, provider: creds.provider, status: "failed", error: msg });
    if (err instanceof EmailProviderError && err.permanent) throw new PermanentJobError(msg);
    throw err;
  }
}

export interface RawEmailPayload {
  to: string;
  name?: string;
  subject: string;
  /** Encrypted JSON {html,text} – may contain one-time links. */
  bodyEnc: string;
  template: string;
}

/** Job handler for "email.raw" (account e-mails, invitations, workflow e-mails). */
export async function handleRawEmail(env: Env, payload: RawEmailPayload, jobId: string): Promise<void> {
  const db = drizzle(env.DB, { schema });
  const body = JSON.parse(await decryptString(env.ENCRYPTION_KEY, payload.bodyEnc, "email-body")) as { html: string; text: string };
  const creds = await getCredentials(db, env, "email");
  if (!creds) {
    await logEmail(env, { jobId, toEmail: payload.to, subject: payload.subject, template: payload.template, status: "skipped", error: "No e-mail provider configured" });
    return;
  }
  try {
    const res = await sendEmail(creds, { to: { email: payload.to, name: payload.name }, subject: payload.subject, html: body.html, text: body.text, idempotencyKey: jobId });
    await logEmail(env, { jobId, toEmail: payload.to, subject: payload.subject, template: payload.template, provider: res.provider, status: "sent", providerMessageId: res.messageId });
  } catch (err) {
    const msg = redactString(err instanceof Error ? err.message : String(err));
    await logEmail(env, { jobId, toEmail: payload.to, subject: payload.subject, template: payload.template, provider: creds.provider, status: "failed", error: msg });
    if (err instanceof EmailProviderError && err.permanent) throw new PermanentJobError(msg);
    throw err;
  }
}

export function simpleEmail(product: string, title: string, paragraphs: string[], button?: { label: string; url: string }) {
  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="560" style="max-width:560px;background:#fff;border:1px solid #e5e7eb;border-radius:12px">
<tr><td style="padding:28px"><h1 style="margin:0 0 12px;font-size:18px;color:#111827">${escapeHtml(title)}</h1>
${paragraphs.map((p) => `<p style="margin:0 0 12px;color:#374151;font-size:14px;line-height:1.6">${escapeHtml(p)}</p>`).join("")}
${button ? `<a href="${escapeHtml(button.url)}" style="display:inline-block;margin-top:8px;padding:10px 16px;border-radius:8px;background:#111827;color:#fff;text-decoration:none;font-weight:600">${escapeHtml(button.label)}</a>` : ""}
</td></tr><tr><td style="padding:16px 28px;border-top:1px solid #f0f1f3;color:#9ca3af;font-size:12px">${escapeHtml(product)}</td></tr></table></td></tr></table></body></html>`;
  const text = [title, "", ...paragraphs, button ? `\n${button.label}: ${button.url}` : ""].join("\n");
  return { html, text };
}

export async function attendeeIdsForBooking(env: Env, bookingId: string): Promise<string[]> {
  const db = drizzle(env.DB, { schema });
  const rows = await db.select({ id: bookingAttendees.id }).from(bookingAttendees).where(and(eq(bookingAttendees.bookingId, bookingId), eq(bookingAttendees.status, "active")));
  return rows.map((r) => r.id);
}
