/**
 * Calendar orchestration: adapter registry, token refresh, free/busy
 * aggregation and booking → external event synchronisation.
 *
 * Known limitation (documented in ARCHITECTURE.md): external calendars can
 * change between our free/busy lookup and the booking write. Internal double
 * bookings are prevented atomically by D1; external conflicts are re-checked
 * right before the write and surfaced as a sync warning if they appear later.
 */
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../../database/schema";
import { bookingAttendees, bookingExternalEvents, bookingHosts, bookings, calendarConnections, calendars, eventTypes, users, type CalendarConnection } from "../../../database/schema";
import type { AppVariables, Env } from "../../env";
import { decryptString, encryptString } from "../../security/crypto";
import { redactString } from "../../security/redact";
import type { Interval } from "../../services/slots";
import { providerConfig, refreshAccessToken } from "../oauth";
import { caldavCalendar } from "./caldav";
import { googleCalendar } from "./google";
import { icsFeedCalendar } from "./ics-feed";
import { microsoftCalendar } from "./microsoft";
import type { CalendarAdapter, CalendarEventInput, ConnectionContext } from "./types";
import { createMeetingLink } from "../meetings";

type Db = AppVariables["db"];

export const ADAPTERS: Record<string, CalendarAdapter> = {
  google: googleCalendar,
  microsoft: microsoftCalendar,
  ics: icsFeedCalendar,
  caldav: caldavCalendar,
};

export function connectionContext(env: Env, db: Db, conn: CalendarConnection): ConnectionContext {
  let cachedToken: string | null = null;
  const ctx: ConnectionContext = {
    credentials: null,
    fetch: (input, init) => fetch(input, init),
    async accessToken() {
      if (cachedToken) return cachedToken;
      cachedToken = await getAccessToken(env, db, conn);
      return cachedToken;
    },
  };
  return ctx;
}

export async function withCredentials(env: Env, db: Db, conn: CalendarConnection): Promise<ConnectionContext> {
  const ctx = connectionContext(env, db, conn);
  if (conn.credentialsEnc) ctx.credentials = JSON.parse(await decryptString(env.ENCRYPTION_KEY, conn.credentialsEnc, "calendar"));
  return ctx;
}

export async function getAccessToken(env: Env, db: Db, conn: CalendarConnection): Promise<string> {
  if (!conn.accessTokenEnc) throw new Error("Connection has no access token");
  const fresh = conn.expiresAt == null || conn.expiresAt - Date.now() > 120_000;
  if (fresh) return decryptString(env.ENCRYPTION_KEY, conn.accessTokenEnc, "calendar");
  if (!conn.refreshTokenEnc) throw new Error("Access token expired and no refresh token available");
  const provider = conn.provider === "zoom" ? "zoom" : (conn.provider as "google" | "microsoft");
  const cfg = await providerConfig(db, env, provider);
  if (!cfg) throw new Error(`${provider} OAuth app is not configured`);
  try {
    const refreshToken = await decryptString(env.ENCRYPTION_KEY, conn.refreshTokenEnc, "calendar");
    const t = await refreshAccessToken(cfg, provider, refreshToken);
    const now = Date.now();
    const update = {
      accessTokenEnc: await encryptString(env.ENCRYPTION_KEY, t.access_token, "calendar"),
      refreshTokenEnc: t.refresh_token ? await encryptString(env.ENCRYPTION_KEY, t.refresh_token, "calendar") : conn.refreshTokenEnc,
      expiresAt: t.expires_in ? now + t.expires_in * 1000 : null,
      status: "active" as const,
      lastError: null,
      updatedAt: now,
    };
    await db.update(calendarConnections).set(update).where(eq(calendarConnections.id, conn.id));
    Object.assign(conn, update);
    return t.access_token;
  } catch (err) {
    const permanent = (err as { permanent?: boolean }).permanent;
    await db
      .update(calendarConnections)
      .set({ status: permanent ? "revoked" : "error", lastError: redactString(err instanceof Error ? err.message : String(err)), updatedAt: Date.now() })
      .where(eq(calendarConnections.id, conn.id));
    throw err;
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => (timer = setTimeout(() => rej(new Error("timeout")), ms)))]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Busy intervals from all connected conflict-checking calendars per user.
 * Failure policy: fail-open (bookings stay possible), the error is stored on
 * the connection and shown in the dashboard's integration status.
 */
export async function getExternalBusy(env: Env, db: Db, userIds: string[], from: number, to: number): Promise<Map<string, Interval[]>> {
  const result = new Map<string, Interval[]>();
  if (userIds.length === 0) return result;
  const conns = await db
    .select()
    .from(calendarConnections)
    .where(and(inArray(calendarConnections.userId, userIds), inArray(calendarConnections.provider, ["google", "microsoft", "ics", "caldav"]), eq(calendarConnections.status, "active")));
  if (conns.length === 0) return result;
  const cals = await db
    .select()
    .from(calendars)
    .where(and(inArray(calendars.connectionId, conns.map((c) => c.id)), eq(calendars.checkConflicts, true)));
  await Promise.all(
    conns.map(async (conn) => {
      const adapter = ADAPTERS[conn.provider];
      const ids = cals.filter((c) => c.connectionId === conn.id).map((c) => c.externalId);
      if (!adapter || ids.length === 0) return;
      try {
        const ctx = await withCredentials(env, db, conn);
        const busy = await withTimeout(adapter.freeBusy(ctx, ids, from, to), 5000);
        const list = result.get(conn.userId) ?? [];
        list.push(...busy);
        result.set(conn.userId, list);
        if (!conn.lastSyncedAt || Date.now() - conn.lastSyncedAt > 60_000 || conn.lastError) {
          await db.update(calendarConnections).set({ lastSyncedAt: Date.now(), lastError: null }).where(eq(calendarConnections.id, conn.id));
        }
      } catch (err) {
        await db
          .update(calendarConnections)
          .set({ lastError: redactString(`Free/busy failed: ${err instanceof Error ? err.message : String(err)}`), updatedAt: Date.now() })
          .where(eq(calendarConnections.id, conn.id));
      }
    }),
  );
  return result;
}

export async function refreshCalendarList(env: Env, db: Db, conn: CalendarConnection): Promise<void> {
  const adapter = ADAPTERS[conn.provider];
  if (!adapter) return;
  const ctx = await withCredentials(env, db, conn);
  const list = await adapter.listCalendars(ctx);
  const existing = await db.select().from(calendars).where(eq(calendars.connectionId, conn.id));
  const hasTarget = (await db
    .select({ id: calendars.id })
    .from(calendars)
    .innerJoin(calendarConnections, eq(calendarConnections.id, calendars.connectionId))
    .where(and(eq(calendarConnections.userId, conn.userId), eq(calendars.isTarget, true)))
    .get()) != null;
  for (const c of list) {
    const found = existing.find((e) => e.externalId === c.externalId);
    if (found) {
      await db.update(calendars).set({ name: c.name, isPrimary: c.primary }).where(eq(calendars.id, found.id));
    } else {
      await db.insert(calendars).values({
        id: crypto.randomUUID(),
        connectionId: conn.id,
        externalId: c.externalId,
        name: c.name,
        checkConflicts: c.primary,
        isTarget: !hasTarget && c.primary && c.writable && adapter.canWrite,
        isPrimary: c.primary,
      });
    }
  }
}

function locationText(b: typeof bookings.$inferSelect): string | null {
  if (b.meetingUrl) return b.meetingUrl;
  return b.locationValue ?? null;
}

/**
 * Creates / updates / deletes the external calendar events of a booking for
 * every host that has a target calendar. Also generates meeting links.
 * Idempotent: safe to run multiple times (job retries).
 */
export async function syncBookingCalendars(env: Env, bookingId: string, action: "upsert" | "delete"): Promise<{ errors: string[] }> {
  const db = drizzle(env.DB, { schema });
  const errors: string[] = [];
  const b = await db.select().from(bookings).where(eq(bookings.id, bookingId)).get();
  if (!b) return { errors };
  const et = await db.select().from(eventTypes).where(eq(eventTypes.id, b.eventTypeId)).get();
  const hosts = await db.select({ id: users.id, name: users.name, email: users.email, timezone: users.timezone }).from(bookingHosts).innerJoin(users, eq(users.id, bookingHosts.userId)).where(eq(bookingHosts.bookingId, bookingId));
  const attendees = await db.select().from(bookingAttendees).where(and(eq(bookingAttendees.bookingId, bookingId), eq(bookingAttendees.status, "active")));

  // Meeting link for providers that are independent of the calendar (Zoom, Jitsi).
  if (action === "upsert" && !b.meetingUrl && b.locationType && ["zoom", "jitsi"].includes(b.locationType)) {
    try {
      const url = await createMeetingLink(env, db, b, hosts[0]?.id ?? b.organizerUserId);
      if (url) {
        await db.update(bookings).set({ meetingUrl: url }).where(eq(bookings.id, b.id));
        b.meetingUrl = url;
      }
    } catch (err) {
      errors.push(`meeting: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const host of hosts) {
    const existing = await db.select().from(bookingExternalEvents).where(and(eq(bookingExternalEvents.bookingId, bookingId), eq(bookingExternalEvents.userId, host.id))).get();
    try {
      if (action === "delete") {
        if (!existing) continue;
        const conn = await db.select().from(calendarConnections).where(eq(calendarConnections.id, existing.connectionId)).get();
        const adapter = conn ? ADAPTERS[conn.provider] : undefined;
        if (conn && adapter) await adapter.deleteEvent(await withCredentials(env, db, conn), existing.calendarExternalId, existing.externalEventId);
        await db.delete(bookingExternalEvents).where(and(eq(bookingExternalEvents.bookingId, bookingId), eq(bookingExternalEvents.userId, host.id)));
        continue;
      }
      const target = await db
        .select({ cal: calendars, conn: calendarConnections })
        .from(calendars)
        .innerJoin(calendarConnections, eq(calendarConnections.id, calendars.connectionId))
        .where(and(eq(calendarConnections.userId, host.id), eq(calendars.isTarget, true), eq(calendarConnections.status, "active")))
        .get();
      const connRow = existing ? await db.select().from(calendarConnections).where(eq(calendarConnections.id, existing.connectionId)).get() : target?.conn;
      if (!connRow) continue;
      const adapter = ADAPTERS[connRow.provider];
      if (!adapter?.canWrite) continue;
      const conference =
        b.locationType === "google_meet" && connRow.provider === "google" ? "google_meet" : b.locationType === "ms_teams" && connRow.provider === "microsoft" ? "ms_teams" : null;
      const input: CalendarEventInput = {
        uid: `${b.id}@openmeet`,
        title: et ? `${et.title}: ${attendees.map((a) => a.name).join(", ")}` : b.title,
        description: [b.title, ...attendees.map((a) => `${a.name} <${a.email}>`), b.cancelReason ? `Note: ${b.cancelReason}` : ""].filter(Boolean).join("\n"),
        start: b.startAt,
        end: b.endAt,
        timezone: host.timezone,
        location: locationText(b),
        attendees: attendees.map((a) => ({ name: a.name, email: a.email })),
        conference: b.meetingUrl ? null : conference,
      };
      const ctx = await withCredentials(env, db, connRow);
      if (existing) {
        const updated = await adapter.updateEvent(ctx, existing.calendarExternalId, existing.externalEventId, input);
        if (updated.meetingUrl && !b.meetingUrl) await db.update(bookings).set({ meetingUrl: updated.meetingUrl }).where(eq(bookings.id, b.id));
      } else if (target) {
        const created = await adapter.createEvent(ctx, target.cal.externalId, input);
        await db
          .insert(bookingExternalEvents)
          .values({ bookingId, userId: host.id, connectionId: connRow.id, calendarExternalId: target.cal.externalId, externalEventId: created.id, createdAt: Date.now() })
          .onConflictDoNothing();
        if (created.meetingUrl && !b.meetingUrl) {
          await db.update(bookings).set({ meetingUrl: created.meetingUrl }).where(eq(bookings.id, b.id));
          b.meetingUrl = created.meetingUrl;
        }
      }
    } catch (err) {
      const msg = redactString(err instanceof Error ? err.message : String(err));
      errors.push(`${host.id}: ${msg}`);
      await db
        .update(calendarConnections)
        .set({ lastError: `Event sync failed: ${msg}`.slice(0, 500), updatedAt: Date.now() })
        .where(and(eq(calendarConnections.userId, host.id), eq(calendarConnections.status, "active")));
    }
  }
  return { errors };
}
