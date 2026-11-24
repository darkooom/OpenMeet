/** Dashboard overview + privacy friendly analytics (aggregates only, no visitor tracking). */
import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { auditLogs, bookingAttendees, bookingHosts, bookings, calendarConnections, eventTypes, jobs, pageViews, users } from "../../database/schema";
import type { AppEnv } from "../env";
import { readQuery } from "../lib/validate";
import { parseJson } from "../lib/json";
import { DAY, toZonedParts } from "../../shared/time";
import { bookingDetails } from "../services/booking";
import { credentialStatus } from "../services/settings";
import { visibleBookingCondition } from "./bookings";
import { listEventTypes } from "./event-types";

export const insightsRoutes = new Hono<AppEnv>();

insightsRoutes.get("/overview", async (c) => {
  const db = c.get("db");
  const user = c.get("actor")!.user;
  const now = Date.now();
  const tz = user.timezone;
  const today = toZonedParts(now, tz);
  const visible = await visibleBookingCondition(db, user);
  const startOfDay = now - today.minuteOfDay * 60_000 - today.second * 1000;
  const endOfDay = startOfDay + DAY;
  const [todayRows, upcomingRows, recent, counts, pending, conns, creds, failedJobs] = await Promise.all([
    db.select({ id: bookings.id }).from(bookings).where(and(visible, gte(bookings.startAt, startOfDay), lt(bookings.startAt, endOfDay), inArray(bookings.status, ["confirmed", "pending"]))).orderBy(bookings.startAt),
    db.select({ id: bookings.id }).from(bookings).where(and(visible, gte(bookings.startAt, now), inArray(bookings.status, ["confirmed", "pending"]))).orderBy(bookings.startAt).limit(6),
    db.select({ id: bookings.id }).from(bookings).where(and(visible, gte(bookings.createdAt, now - 7 * DAY))).orderBy(desc(bookings.createdAt)).limit(6),
    db
      .select({ status: bookings.status, n: sql<number>`count(*)` })
      .from(bookings)
      .where(and(visible, gte(bookings.createdAt, now - 30 * DAY)))
      .groupBy(bookings.status),
    db.select({ n: sql<number>`count(*)` }).from(bookings).where(and(visible, eq(bookings.status, "pending"), gte(bookings.startAt, now))).get(),
    db.select().from(calendarConnections).where(eq(calendarConnections.userId, user.id)),
    credentialStatus(db),
    user.isSuperAdmin ? db.select({ n: sql<number>`count(*)` }).from(jobs).where(eq(jobs.status, "dead")).get() : Promise.resolve(null),
  ]);
  const cancelledLast7 = await db.select({ n: sql<number>`count(*)` }).from(bookings).where(and(visible, inArray(bookings.status, ["cancelled", "rejected"]), gte(bookings.cancelledAt, now - 7 * DAY))).get();
  const newLast7 = await db.select({ n: sql<number>`count(*)` }).from(bookings).where(and(visible, gte(bookings.createdAt, now - 7 * DAY))).get();
  const byStatus = Object.fromEntries(counts.map((r) => [r.status, Number(r.n)]));
  const total30 = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const notifications: { level: "info" | "warning" | "error"; message: string; href?: string }[] = [];
  if (!user.emailVerified) notifications.push({ level: "warning", message: "Confirm your e-mail address to activate your public booking page.", href: "/app/settings" });
  if (!creds.email) notifications.push({ level: "info", message: "No e-mail provider configured – confirmations and reminders are not sent.", href: user.isSuperAdmin ? "/app/admin" : undefined });
  for (const conn of conns.filter((x) => x.lastError || x.status !== "active")) {
    notifications.push({ level: "error", message: `${conn.provider} (${conn.accountEmail ?? "calendar"}): ${conn.status !== "active" ? `connection ${conn.status}` : conn.lastError}`, href: "/app/integrations" });
  }
  if (failedJobs && Number(failedJobs.n) > 0) notifications.push({ level: "warning", message: `${failedJobs.n} background job(s) failed permanently.`, href: "/app/admin" });
  const activity = await db
    .select({ action: auditLogs.action, createdAt: auditLogs.createdAt, targetType: auditLogs.targetType, actorId: auditLogs.actorId })
    .from(auditLogs)
    .where(or(eq(auditLogs.actorId, user.id), sql`${auditLogs.targetId} IN (SELECT booking_id FROM booking_hosts WHERE user_id = ${user.id})`))
    .orderBy(desc(auditLogs.createdAt))
    .limit(8);
  return c.json({
    today: await bookingDetails(db, todayRows.map((r) => r.id)),
    upcoming: await bookingDetails(db, upcomingRows.map((r) => r.id)),
    recent: await bookingDetails(db, recent.map((r) => r.id)),
    stats: {
      last30Days: total30,
      confirmed30: byStatus.confirmed ?? 0,
      cancelled30: (byStatus.cancelled ?? 0) + (byStatus.rejected ?? 0),
      pending: Number(pending?.n ?? 0),
      newLast7: Number(newLast7?.n ?? 0),
      cancelledLast7: Number(cancelledLast7?.n ?? 0),
    },
    bookingLink: `${c.get("baseUrl")}/u/${user.username}`,
    integrations: conns.map((x) => ({ id: x.id, provider: x.provider, accountEmail: x.accountEmail, status: x.status, lastError: x.lastError, lastSyncedAt: x.lastSyncedAt })),
    notifications,
    activity,
  });
});

const rangeQuery = z.object({ from: z.coerce.number().int().optional(), to: z.coerce.number().int().optional() });

insightsRoutes.get("/analytics", async (c) => {
  const db = c.get("db");
  const user = c.get("actor")!.user;
  const q = readQuery(c, rangeQuery);
  const to = q.to ?? Date.now() + 30 * DAY;
  const from = q.from ?? Date.now() - 90 * DAY;
  const visible = await visibleBookingCondition(db, user);
  const rows = await db
    .select({ b: bookings, etTitle: eventTypes.title })
    .from(bookings)
    .innerJoin(eventTypes, eq(eventTypes.id, bookings.eventTypeId))
    .where(and(visible, gte(bookings.startAt, from), lt(bookings.startAt, to)));
  const ids = rows.map((r) => r.b.id);
  const hosts = ids.length > 0 ? await db.select({ bookingId: bookingHosts.bookingId, name: users.name }).from(bookingHosts).innerJoin(users, eq(users.id, bookingHosts.userId)).where(inArray(bookingHosts.bookingId, ids)) : [];
  const total = rows.length;
  const cancelled = rows.filter((r) => r.b.status === "cancelled" || r.b.status === "rejected").length;
  const past = rows.filter((r) => r.b.endAt < Date.now() && r.b.status === "confirmed");
  const noShows = past.filter((r) => r.b.noShow).length;
  const leadTimes = rows.map((r) => r.b.startAt - r.b.createdAt).filter((x) => x > 0);
  const byEventType = new Map<string, number>();
  const byMember = new Map<string, number>();
  const bySource = new Map<string, number>();
  const byUtm = new Map<string, number>();
  const heat: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
  for (const r of rows) {
    byEventType.set(r.etTitle, (byEventType.get(r.etTitle) ?? 0) + 1);
    for (const h of hosts.filter((x) => x.bookingId === r.b.id)) byMember.set(h.name, (byMember.get(h.name) ?? 0) + 1);
    const utm = parseJson<Record<string, string> | null>(r.b.utm, null);
    const source = utm?.utm_source ?? r.b.source ?? "direct";
    bySource.set(source, (bySource.get(source) ?? 0) + 1);
    if (utm?.utm_campaign) byUtm.set(utm.utm_campaign, (byUtm.get(utm.utm_campaign) ?? 0) + 1);
    if (r.b.status !== "cancelled" && r.b.status !== "rejected") {
      const p = toZonedParts(r.b.startAt, user.timezone);
      heat[p.weekday]![p.hour]!++;
    }
  }
  const ets = await listEventTypes(db, user);
  const views = ets.length > 0
    ? await db
        .select({ eventTypeId: pageViews.eventTypeId, views: sql<number>`sum(${pageViews.views})` })
        .from(pageViews)
        .where(and(inArray(pageViews.eventTypeId, ets.map((e) => e.id)), gte(pageViews.day, new Date(from).toISOString().slice(0, 10)), lt(pageViews.day, new Date(to).toISOString().slice(0, 10))))
        .groupBy(pageViews.eventTypeId)
    : [];
  const conversion = ets.map((e) => {
    const v = Number(views.find((x) => x.eventTypeId === e.id)?.views ?? 0);
    const b = rows.filter((r) => r.b.eventTypeId === e.id).length;
    return { eventType: e.title, views: v, bookings: b, rate: v > 0 ? b / v : null };
  });
  const sorted = (m: Map<string, number>) => [...m.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
  return c.json({
    range: { from, to },
    total,
    cancelled,
    cancellationRate: total > 0 ? cancelled / total : 0,
    noShowRate: past.length > 0 ? noShows / past.length : 0,
    avgLeadTimeHours: leadTimes.length > 0 ? leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length / 3_600_000 : null,
    byEventType: sorted(byEventType),
    byMember: sorted(byMember),
    bySource: sorted(bySource),
    byCampaign: sorted(byUtm),
    heatmap: heat,
    conversion,
  });
});

function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

insightsRoutes.get("/bookings.csv", async (c) => {
  const db = c.get("db");
  const user = c.get("actor")!.user;
  const q = readQuery(c, rangeQuery);
  const visible = await visibleBookingCondition(db, user);
  const rows = await db
    .select({ b: bookings, et: eventTypes.title })
    .from(bookings)
    .innerJoin(eventTypes, eq(eventTypes.id, bookings.eventTypeId))
    .where(and(visible, q.from ? gte(bookings.startAt, q.from) : undefined, q.to ? lt(bookings.startAt, q.to) : undefined))
    .orderBy(desc(bookings.startAt))
    .limit(10000);
  const ids = rows.map((r) => r.b.id);
  const att = ids.length > 0 ? await db.select().from(bookingAttendees).where(inArray(bookingAttendees.bookingId, ids)) : [];
  const header = ["booking_id", "event_type", "status", "start_utc", "end_utc", "attendee_name", "attendee_email", "attendee_timezone", "no_show", "source", "utm", "created_utc"];
  const lines = [header.join(",")];
  for (const r of rows) {
    for (const a of att.filter((x) => x.bookingId === r.b.id)) {
      lines.push(
        [r.b.id, r.et, r.b.status, new Date(r.b.startAt).toISOString(), new Date(r.b.endAt).toISOString(), a.name, a.email, a.timezone, a.noShow ? "yes" : "no", r.b.source ?? "", r.b.utm ?? "", new Date(r.b.createdAt).toISOString()]
          .map(csvCell)
          .join(","),
      );
    }
  }
  return c.body(lines.join("\n"), 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="openmeet-bookings.csv"` });
});
